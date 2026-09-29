// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeMotionWake } from "./motionWake";

const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("motion wake on inserted content", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("wakes idle motion when a new step or loaded content is mounted", async () => {
    const shell = document.createElement("div");
    document.body.append(shell);
    const wake = vi.fn();
    const stop = observeMotionWake(document.body, () => true, wake);

    const step = document.createElement("div");
    step.innerHTML = "<h1>Add works to your library</h1>";
    shell.append(step);
    await flushMutations();
    expect(wake).toHaveBeenCalledTimes(1);

    stop();
    shell.append(document.createElement("section"));
    await flushMutations();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("ignores text updates and stays asleep while the caller forbids waking", async () => {
    const label = document.createElement("span");
    label.textContent = "0%";
    document.body.append(label);
    let idleAndVisible = true;
    const wake = vi.fn();
    const stop = observeMotionWake(document.body, () => idleAndVisible, wake);

    label.textContent = "50%";
    label.append(document.createTextNode(" loaded"));
    await flushMutations();
    expect(wake).not.toHaveBeenCalled();

    idleAndVisible = false;
    document.body.append(document.createElement("div"));
    await flushMutations();
    expect(wake).not.toHaveBeenCalled();
    stop();
  });

  it("is wired to the whole document before the shell is ready, so first-run steps are covered", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.svelte"), "utf8");
    expect(app).toContain("observeMotionWake(document.body, () => !uiMotionActive && !pageHidden, scheduleUiMotionPause)");
    expect(app).toContain("stopMotionWake();");
  });
});
