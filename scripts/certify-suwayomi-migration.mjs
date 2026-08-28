import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  allocateLoopbackPort,
  assertPortOwnedByProcess,
  graphqlRequest,
  readJarVersion,
  redactDiagnosticText,
  sampleProcessMetrics,
  serverConfig,
  sha256,
  startRuntime,
  stopRuntime,
  waitForHealth,
} from "./certify-suwayomi-release.mjs";

const EXPECTED_BASELINE_VERSION = "v2.1.1867";
const EXPECTED_CANDIDATE_VERSION = "v2.3.2243";
const CERTIFICATION_STORE_URL = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json";
const CERTIFICATION_STORE_CANONICAL_URL = "https://github.com/keiyoushi/extensions/raw/repo/index.pb";
const HELPER_EXTENSION_PACKAGES = new Set(["eu.kanade.tachiyomi.extension.all.tachidesk"]);
const PROFILE_ROOT_FILES = ["database.mv.db"];
const PROFILE_TREES = ["extensions", "settings"];
const COMMON_STATE_QUERY = `
  query EpigraphMigrationState {
    library: mangas(condition: { inLibrary: true }) {
      nodes { id sourceId inLibrary downloadCount unreadCount }
    }
    chapters {
      nodes { id mangaId isRead isDownloaded isBookmarked lastPageRead }
    }
    categories {
      nodes {
        id order default includeInUpdate includeInDownload
        mangas { nodes { id } }
      }
    }
    sources { nodes { id lang extension { pkgName } } }
  }
`;
const V21_EXTENSIONS_QUERY = `
  query EpigraphMigrationExtensionsV21 {
    extensions {
      nodes { pkgName versionCode isInstalled isObsolete hasUpdate }
    }
    settings { extensionRepos }
  }
`;
const V23_EXTENSIONS_QUERY = `
  query EpigraphMigrationExtensionsV23 {
    extensions {
      nodes { pkgName versionCodeLong isInstalled isObsolete hasUpdate storeIndexUrl }
    }
    extensionStores { nodes { indexUrl isLegacy } }
  }
`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
    }
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function sortCanonical(value) {
  if (Array.isArray(value)) {
    return value.map(sortCanonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortCanonical(entry)]),
    );
  }
  return value;
}

export function summarizeRuntimeState(commonPayload, extensionPayload, profile) {
  const common = commonPayload?.data;
  const extensions = extensionPayload?.data?.extensions?.nodes;
  if (!common || !Array.isArray(common.library?.nodes) || !Array.isArray(common.chapters?.nodes)
    || !Array.isArray(common.categories?.nodes) || !Array.isArray(common.sources?.nodes)
    || !Array.isArray(extensions)) {
    throw new Error("Runtime migration state payload is incomplete.");
  }
  const state = sortCanonical({
    library: common.library.nodes,
    chapters: common.chapters.nodes,
    categories: common.categories.nodes,
    sources: common.sources.nodes,
    extensions: extensions
      .filter((extension) => extension.isInstalled)
      .map((extension) => ({
        pkgName: extension.pkgName,
        versionCode: String(profile === "v23" ? extension.versionCodeLong : extension.versionCode),
        isInstalled: true,
      })),
  });
  const serialized = JSON.stringify(state);
  const chapters = common.chapters.nodes;
  const installedPackageNames = extensions
    .filter((extension) => extension.isInstalled)
    .map((extension) => String(extension.pkgName));
  const loadedPackageNames = new Set(common.sources.nodes
    .map((source) => source.extension?.pkgName)
    .filter((packageName) => typeof packageName === "string"));
  const unloadedContentPackages = installedPackageNames.filter(
    (packageName) => !HELPER_EXTENSION_PACKAGES.has(packageName) && !loadedPackageNames.has(packageName),
  );
  const storeUrls = profile === "v23"
    ? extensionPayload.data.extensionStores?.nodes?.map((store) => store.indexUrl) ?? []
    : extensionPayload.data.settings?.extensionRepos ?? [];
  return {
    sha256: createHash("sha256").update(serialized).digest("hex"),
    counts: {
      library: common.library.nodes.length,
      chapters: chapters.length,
      readChapters: chapters.filter((chapter) => chapter.isRead).length,
      bookmarkedChapters: chapters.filter((chapter) => chapter.isBookmarked).length,
      progressedChapters: chapters.filter((chapter) => Number(chapter.lastPageRead) > 0).length,
      categories: common.categories.nodes.length,
      installedExtensions: extensions.filter((extension) => extension.isInstalled).length,
      sources: common.sources.nodes.length,
      stores: storeUrls.length,
    },
    extensionCanary: {
      installedPackageHashes: installedPackageNames.map((packageName) => sha256(packageName)).sort(),
      loadedPackageHashes: [...loadedPackageNames].map((packageName) => sha256(packageName)).sort(),
      unloadedContentPackageHashes: unloadedContentPackages.map((packageName) => sha256(packageName)).sort(),
    },
    storeUrlHashes: storeUrls.map((url) => sha256(String(url))).sort(),
  };
}

async function fileManifest(root) {
  const entries = [];
  async function visit(absolute, relative) {
    const metadata = await stat(absolute);
    if (metadata.isDirectory()) {
      const children = await readdir(absolute);
      for (const child of children.sort()) await visit(path.join(absolute, child), path.join(relative, child));
      return;
    }
    const bytes = await readFile(absolute);
    entries.push({ path: relative.replaceAll("\\", "/"), bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  for (const name of PROFILE_ROOT_FILES) {
    const source = path.join(root, name);
    try { await visit(source, name); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  for (const name of PROFILE_TREES) {
    const source = path.join(root, name);
    try { await visit(source, name); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  return entries;
}

export async function copyAllowlistedProfile(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const name of PROFILE_ROOT_FILES) {
    const from = path.join(source, name);
    try { await cp(from, path.join(destination, name)); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  for (const name of PROFILE_TREES) {
    const from = path.join(source, name);
    try { await cp(from, path.join(destination, name), { recursive: true }); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

async function collectState(endpoint, profile) {
  const [common, extensions] = await Promise.all([
    graphqlRequest(endpoint, COMMON_STATE_QUERY, 30_000),
    graphqlRequest(endpoint, profile === "v23" ? V23_EXTENSIONS_QUERY : V21_EXTENSIONS_QUERY, 30_000),
  ]);
  return summarizeRuntimeState(common, extensions, profile);
}

async function runRuntimePhase({ java, jar, root, profile, timeoutMs }) {
  const port = await allocateLoopbackPort();
  const stores = [CERTIFICATION_STORE_URL];
  await writeFile(path.join(root, "server.conf"), serverConfig(port, profile === "v23"
    ? { extensionStores: stores }
    : { extensionRepos: stores }));
  const endpoint = `http://127.0.0.1:${port}/api/graphql`;
  const runtime = startRuntime(java, jar, root);
  const started = Date.now();
  try {
    const health = await waitForHealth(endpoint, runtime, timeoutMs);
    await assertPortOwnedByProcess(port, runtime.child.pid);
    return {
      durationMs: Date.now() - started,
      healthAttempts: health.attempts,
      process: await sampleProcessMetrics(runtime.child.pid),
      storeMigration: profile === "v23" ? "generated-v23-config" : null,
      state: await collectState(endpoint, profile),
    };
  } catch (error) {
    const tail = runtime.output.slice(-20).join("\n");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${tail}`);
  } finally {
    await stopRuntime(runtime.child, port);
  }
}

function assertSameState(expected, actual, label) {
  if (expected.sha256 !== actual.sha256) throw new Error(`${label} changed the normalized library/progress state.`);
}

export function assertStoreMigration({ baseline, candidate, restart, rollback }) {
  const legacyHash = sha256(CERTIFICATION_STORE_URL);
  const canonicalHash = sha256(CERTIFICATION_STORE_CANONICAL_URL);
  if (!baseline.storeUrlHashes.includes(legacyHash)) throw new Error("V21 certification store was not loaded.");
  if (!candidate.storeUrlHashes.includes(canonicalHash)) {
    throw new Error("V23 did not canonicalize the certification Extension Store.");
  }
  if (JSON.stringify(candidate.storeUrlHashes) !== JSON.stringify(restart.storeUrlHashes)) {
    throw new Error("V23 Extension Stores changed after restart.");
  }
  if (!rollback.storeUrlHashes.includes(legacyHash)) {
    throw new Error("V21 rollback did not restore the certification extension repository.");
  }
}

export function assertExtensionCanaries({ baseline, candidate, restart, rollback }) {
  for (const [label, state] of Object.entries({ baseline, candidate, restart, rollback })) {
    if (state.extensionCanary.installedPackageHashes.length === 0) {
      throw new Error(`${label} did not load any installed extension canary.`);
    }
    if (state.extensionCanary.unloadedContentPackageHashes.length > 0) {
      throw new Error(`${label} left installed content extensions without registered sources.`);
    }
  }
  if (JSON.stringify(baseline.extensionCanary.installedPackageHashes)
    !== JSON.stringify(candidate.extensionCanary.installedPackageHashes)) {
    throw new Error("V23 changed the installed extension canary set.");
  }
  if (JSON.stringify(candidate.extensionCanary.installedPackageHashes)
    !== JSON.stringify(restart.extensionCanary.installedPackageHashes)) {
    throw new Error("V23 extension canaries changed after restart.");
  }
  if (JSON.stringify(baseline.extensionCanary.installedPackageHashes)
    !== JSON.stringify(rollback.extensionCanary.installedPackageHashes)) {
    throw new Error("V21 rollback did not restore the extension canary set.");
  }
}

async function verifyJar(jarPath, expectedVersion, expectedSha256) {
  const bytes = await readFile(jarPath);
  if (sha256(bytes) !== expectedSha256) throw new Error(`${expectedVersion} JAR checksum does not match the compatibility manifest.`);
  if (await readJarVersion(bytes) !== expectedVersion) throw new Error(`JAR does not declare ${expectedVersion}.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const required = ["profile-source", "baseline-jar", "candidate-jar", "java", "manifest", "artifact-dir"];
  for (const name of required) if (!options[name]) throw new Error(`Missing --${name}.`);
  const profileSource = path.resolve(options["profile-source"]);
  const baselineJar = path.resolve(options["baseline-jar"]);
  const candidateJar = path.resolve(options["candidate-jar"]);
  const java = path.resolve(options.java);
  const manifest = JSON.parse(await readFile(path.resolve(options.manifest), "utf8"));
  const baselineEntry = manifest.allowedVersions?.find((entry) => entry.version === EXPECTED_BASELINE_VERSION);
  const candidateSha256 = options["candidate-sha256"];
  if (!baselineEntry?.sha256 || !candidateSha256) throw new Error("Certification checksums are incomplete.");
  await verifyJar(baselineJar, EXPECTED_BASELINE_VERSION, baselineEntry.sha256);
  await verifyJar(candidateJar, EXPECTED_CANDIDATE_VERSION, candidateSha256);

  const artifactDir = path.resolve(options["artifact-dir"]);
  await mkdir(artifactDir, { recursive: true });
  const reportPath = path.join(artifactDir, "migration-certification-report.json");
  const timeoutMs = Number.parseInt(options["timeout-ms"] ?? "180000", 10);
  const report = {
    schemaVersion: 1,
    baselineVersion: EXPECTED_BASELINE_VERSION,
    candidateVersion: EXPECTED_CANDIDATE_VERSION,
    profilePolicy: "explicit-read-only-source-allowlisted-copy",
    originalProfileModified: false,
    passed: false,
    startedAt: new Date().toISOString(),
  };
  let root;
  try {
    const before = await fileManifest(profileSource);
    if (!before.some((entry) => entry.path === "database.mv.db")) throw new Error("Profile source has no H2 database.");
    root = await mkdtemp(path.join(tmpdir(), "epigraph-suwayomi-migration-"));
    const baselineRoot = path.join(root, "baseline");
    const candidateRoot = path.join(root, "candidate");
    const rollbackRoot = path.join(root, "rollback");
    await copyAllowlistedProfile(profileSource, baselineRoot);
    report.baseline = await runRuntimePhase({ java, jar: baselineJar, root: baselineRoot, profile: "v21", timeoutMs });
    await copyAllowlistedProfile(baselineRoot, candidateRoot);
    await rm(path.join(candidateRoot, "server.conf"), { force: true });
    await copyAllowlistedProfile(baselineRoot, rollbackRoot);
    await rm(path.join(rollbackRoot, "server.conf"), { force: true });
    report.candidate = {
      initial: await runRuntimePhase({ java, jar: candidateJar, root: candidateRoot, profile: "v23", timeoutMs }),
      restart: await runRuntimePhase({ java, jar: candidateJar, root: candidateRoot, profile: "v23", timeoutMs }),
    };
    report.rollback = await runRuntimePhase({ java, jar: baselineJar, root: rollbackRoot, profile: "v21", timeoutMs });
    assertSameState(report.baseline.state, report.candidate.initial.state, "H2 migration");
    assertSameState(report.candidate.initial.state, report.candidate.restart.state, "Candidate restart");
    assertSameState(report.baseline.state, report.rollback.state, "Snapshot rollback");
    assertStoreMigration({
      baseline: report.baseline.state,
      candidate: report.candidate.initial.state,
      restart: report.candidate.restart.state,
      rollback: report.rollback.state,
    });
    assertExtensionCanaries({
      baseline: report.baseline.state,
      candidate: report.candidate.initial.state,
      restart: report.candidate.restart.state,
      rollback: report.rollback.state,
    });
    const after = await fileManifest(profileSource);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Original profile changed during certification.");
    report.sourceManifest = { files: before.length, sha256: sha256(JSON.stringify(before)) };
    report.originalProfileModified = false;
    report.passed = true;
  } catch (error) {
    report.error = redactDiagnosticText(error instanceof Error ? error.message : String(error), [profileSource, root]);
    process.exitCode = 1;
  } finally {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    report.completedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (!report.passed) throw new Error(report.error ?? "Migration certification failed.");
  process.stdout.write(`Suwayomi ${EXPECTED_CANDIDATE_VERSION} migration certified.\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
