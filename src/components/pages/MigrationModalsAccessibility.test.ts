import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDialogFocusBoundary } from "../../lib/accessibility/dialogFocus";

const MODALS = [
  "src/components/pages/MassMigrateModal.svelte",
  "src/components/pages/MigrateModal.svelte",
  "src/components/pages/NovelMigrateModal.svelte",
] as const;

afterEach(() => {
  document.body.replaceChildren();
});

describe("migration modal accessibility", () => {
  test("all migration modals use the shared focus boundary and modal semantics", () => {
    for (const path of MODALS) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      expect(source).toContain('import { createDialogFocusBoundary } from "../../lib/accessibility/dialogFocus";');
      expect(source).toContain("return createDialogFocusBoundary({");
      expect(source).toContain("bind:this={overlayEl}");
      expect(source).toContain("bind:this={modalEl}");
      expect(source).toContain('role="dialog"');
      expect(source).toContain('aria-modal="true"');
      expect(source).toContain('tabindex="-1"');
      expect(source).toContain("bind:this={closeButtonEl}");
    }
  });

  test("keeps every migration modal open while a migration is running", () => {
    const busyFlag: Record<(typeof MODALS)[number], string> = {
      "src/components/pages/MassMigrateModal.svelte": "applying",
      "src/components/pages/MigrateModal.svelte": "migrating",
      "src/components/pages/NovelMigrateModal.svelte": "migrating",
    };
    for (const path of MODALS) {
      const source = readFileSync(resolve(process.cwd(), path), "utf8");
      const busy = busyFlag[path];
      expect(source).toContain(`key === "Escape" && !${busy}) onClose();`);
      expect(source).toContain(`onclick={onClose} disabled={${busy}}`);
    }
    expect(readFileSync(resolve(process.cwd(), MODALS[0]), "utf8")).toContain("event.target === event.currentTarget && !applying");
    expect(readFileSync(resolve(process.cwd(), MODALS[1]), "utf8")).toContain("e.target === e.currentTarget && !migrating");
    expect(readFileSync(resolve(process.cwd(), MODALS[2]), "utf8")).toContain('disabled={migrating} onclick={onClose}></button>');
  });

  test("isolates the background, wraps focus, and restores prior focus", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open migration";
    document.body.append(opener);
    opener.focus();

    const host = document.createElement("div");
    const overlay = document.createElement("div");
    const backdrop = document.createElement("button");
    const dialog = document.createElement("div");
    const first = document.createElement("button");
    const disabled = document.createElement("button");
    const last = document.createElement("button");
    disabled.disabled = true;
    dialog.tabIndex = -1;
    dialog.append(first, disabled, last);
    overlay.append(backdrop, dialog);
    host.append(overlay);
    document.body.append(host);

    const release = createDialogFocusBoundary({ dialog, isolationRoot: overlay, initialFocus: first });
    await new Promise((resolveTimer) => window.setTimeout(resolveTimer));

    expect(opener.inert).toBe(true);
    expect(backdrop.inert).not.toBe(true);
    expect(document.activeElement).toBe(first);

    last.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(first);

    first.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(last);

    release();
    expect(opener.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  test("preserves siblings that were already inert", () => {
    const existingInert = document.createElement("div");
    existingInert.inert = true;
    const overlay = document.createElement("div");
    const dialog = document.createElement("div");
    dialog.tabIndex = -1;
    overlay.append(dialog);
    document.body.append(existingInert, overlay);

    const release = createDialogFocusBoundary({ dialog, isolationRoot: overlay });
    release();

    expect(existingInert.inert).toBe(true);
  });
});
