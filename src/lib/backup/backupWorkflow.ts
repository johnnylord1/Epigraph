import { detectBackupImportKind, type BackupImportKind } from "./backupRollout";
import type { EpigraphRestorePlan } from "./epigraphRestorePlanner";
import { createSharedRestoreCoordinator, type DomainInvocation } from "./sharedRestoreCoordinator";

export type BackupLibraryKind = "manga" | "books" | "novels" | "app";
export type BackupSourceKind = "manga" | "novels";

export interface BackupInspection {
  plan: EpigraphRestorePlan | null;
  restoreData?: unknown;
  workCount: number;
  chapterCount: number;
  repositoryCount: number;
  extensionCount: number;
  conflictCount: number;
  libraryKinds: BackupLibraryKind[];
  needsSourceKinds: BackupSourceKind[];
}

export interface BackupWorkflowFile extends BackupInspection {
  key: string;
  path: string | null;
  file: File;
  name: string;
  kind: BackupImportKind | null;
  status: "inspecting" | "ready" | "invalid";
  error: string | null;
  restoreProgress: number;
}

export interface BackupWorkflowSummary {
  workCount: number;
  chapterCount: number;
  repositoryCount: number;
  extensionCount: number;
  conflictCount: number;
  libraryKinds: BackupLibraryKind[];
  needsSourceKinds: BackupSourceKind[];
}

export interface BackupWorkflowDependencies {
  inspect(file: File, kind: BackupImportKind): Promise<BackupInspection>;
  restore(file: BackupWorkflowFile, onProgress: (progress: number) => void): Promise<void>;
  target?(): string;
  admit?(): Promise<() => Promise<void>>;
  ready?(files: readonly BackupWorkflowFile[]): Promise<boolean>;
  invocations?(file: BackupWorkflowFile, onProgress: (progress: number) => void): DomainInvocation[];
}

async function fileKey(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `${[...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("")}:${bytes.byteLength}`;
}

function emptyInspection(): BackupInspection {
  return {
    plan: null,
    workCount: 0,
    chapterCount: 0,
    repositoryCount: 0,
    extensionCount: 0,
    conflictCount: 0,
    libraryKinds: [],
    needsSourceKinds: [],
  };
}

function uniqueInOrder<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function createBackupWorkflow(dependencies: BackupWorkflowDependencies) {
  let selected: readonly BackupWorkflowFile[] = [];
  const instanceTarget = crypto.randomUUID();
  const coordinator = createSharedRestoreCoordinator({
    target: dependencies.target ?? (() => instanceTarget),
    admit: dependencies.admit,
    ready: async () => dependencies.ready ? dependencies.ready(selected) : true,
  });
  async function inspectFiles(
    selectedFiles: readonly File[],
    currentFiles: readonly BackupWorkflowFile[] = [],
  ): Promise<BackupWorkflowFile[]> {
    const currentByKey = new Map(currentFiles.map((entry) => [entry.key, entry]));
    const ordered = [...currentFiles];
    const known = new Set(currentByKey.keys());

    for (const file of selectedFiles) {
      const key = await fileKey(file);
      if (known.has(key)) continue;
      known.add(key);
      const kind = detectBackupImportKind(file.name);
      const base: BackupWorkflowFile = {
        ...emptyInspection(),
        key,
        path: null,
        file,
        name: file.name,
        kind,
        status: "inspecting",
        error: null,
        restoreProgress: 0,
      };
      ordered.push(base);

      if (!kind) {
        Object.assign(base, { status: "invalid", error: "Unsupported backup format." });
        continue;
      }

      try {
        const inspected = await dependencies.inspect(file, kind);
        Object.assign(base, inspected, { status: "ready", error: null });
      } catch (error) {
        Object.assign(base, {
          ...emptyInspection(),
          status: "invalid",
          error: error instanceof Error ? error.message : "This backup could not be inspected.",
        });
      }
    }

    return ordered;
  }

  function summarize(files: readonly BackupWorkflowFile[]): BackupWorkflowSummary {
    const ready = files.filter((file) => file.status === "ready");
    return {
      workCount: ready.reduce((sum, file) => sum + file.workCount, 0),
      chapterCount: ready.reduce((sum, file) => sum + file.chapterCount, 0),
      repositoryCount: ready.reduce((sum, file) => sum + file.repositoryCount, 0),
      extensionCount: ready.reduce((sum, file) => sum + file.extensionCount, 0),
      conflictCount: ready.reduce((sum, file) => sum + file.conflictCount, 0),
      libraryKinds: uniqueInOrder(ready.flatMap((file) => file.libraryKinds)),
      needsSourceKinds: uniqueInOrder(ready.flatMap((file) => file.needsSourceKinds)),
    };
  }

  async function restoreFiles(files: readonly BackupWorkflowFile[]): Promise<void> {
    if (coordinator.snapshot().running) throw Error("RESTORE_CONFLICT");
    selected = files.filter(file => file.status === "ready");
    if (selected.length === 0) throw Error("RESTORE_NO_VALID_INPUT");
    const units = selected.flatMap(file => {
      const onProgress = (progress: number) => {
        file.restoreProgress = Math.max(file.restoreProgress, Math.min(1, Math.max(0, progress)));
      };
      return dependencies.invocations?.(file, onProgress) ?? [{
        id: file.key, domain: file.libraryKinds.includes("manga") ? "manga" as const : file.libraryKinds[0] ?? "app" as const,
        execute: async () => { await dependencies.restore(file, onProgress); file.restoreProgress = 1; },
      }];
    });
    await coordinator.run(units);
  }

  return { inspectFiles, summarize, restoreFiles, observe: coordinator.observe, detach: coordinator.detach, requestCancel: coordinator.cancel, snapshot: coordinator.snapshot };
}

export type BackupWorkflow = ReturnType<typeof createBackupWorkflow>;
