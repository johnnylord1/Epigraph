import { afterEach, describe, expect, test } from "vitest";
import { addToast, clearProgressToast, dismissToast, finishProgressToast, isProgressToastActive, showProgressToast, store } from "./state.svelte";

describe("toast rules", () => {
  afterEach(() => {
    store.toasts = [];
  });

  test("a task's report updates its toast in place", () => {
    addToast({ kind: "info", title: "First" });
    showProgressToast("task", { title: "Working", progress: { percent: 10 } });
    addToast({ kind: "info", title: "Last" });
    showProgressToast("task", { title: "Working", progress: { percent: 40 } });

    expect(store.toasts.map((toast) => toast.title)).toEqual(["First", "Working", "Last"]);
    expect(store.toasts[1]).toMatchObject({ duration: 0, progress: { percent: 40, active: true } });
    expect(isProgressToastActive("task")).toBe(true);
  });

  test("a report without a percent drops the previous one", () => {
    showProgressToast("task", { title: "Working", progress: { percent: 40 } });
    showProgressToast("task", { title: "Working" });

    expect(store.toasts[0]?.progress).toEqual({ active: true });
  });

  test("closing a running task hides it until the task finishes", () => {
    showProgressToast("task", { title: "Working" });
    dismissToast("task");
    showProgressToast("task", { title: "Working", progress: { percent: 50 } });

    expect(store.toasts[0]).toMatchObject({ hidden: true, progress: { percent: 50, active: true } });

    finishProgressToast("task", { kind: "success", title: "Done" });
    expect(store.toasts).toEqual([]);
  });

  test("an error outcome shows again after the toast was closed", () => {
    showProgressToast("task", { title: "Working" });
    dismissToast("task");
    finishProgressToast("task", { kind: "error", title: "Failed" });

    expect(store.toasts[0]).toMatchObject({ kind: "error", title: "Failed", duration: 4000 });
    expect(store.toasts[0]?.hidden).toBeUndefined();
    expect(isProgressToastActive("task")).toBe(false);
  });

  test("a finished task closes like any other toast", () => {
    showProgressToast("task", { title: "Working", progress: { percent: 100 } });
    finishProgressToast("task", { kind: "success", title: "Done", progress: { percent: 100 }, duration: 1800 });
    expect(store.toasts[0]).toMatchObject({ duration: 1800, progress: { active: false } });

    dismissToast("task");
    expect(store.toasts).toEqual([]);
  });

  test("a toast with an id never takes over another toast with the same title", () => {
    addToast({ kind: "info", title: "Same" });
    showProgressToast("task", { kind: "info", title: "Same" });
    addToast({ kind: "info", title: "Same" });

    expect(store.toasts).toHaveLength(2);
    expect(isProgressToastActive("task")).toBe(true);
  });

  test("a full stack drops the oldest finished toast, never a running task", () => {
    showProgressToast("task", { title: "Working" });
    for (let index = 0; index < 6; index += 1) addToast({ kind: "info", title: `Note ${index}` });

    expect(store.toasts).toHaveLength(5);
    expect(store.toasts[0]?.id).toBe("task");
    expect(store.toasts.map((toast) => toast.title)).toEqual(["Working", "Note 2", "Note 3", "Note 4", "Note 5"]);
  });

  test("a hidden task does not count toward the stack", () => {
    showProgressToast("task", { title: "Working" });
    dismissToast("task");
    for (let index = 0; index < 5; index += 1) addToast({ kind: "info", title: `Note ${index}` });

    expect(store.toasts).toHaveLength(6);
    expect(store.toasts.filter((toast) => !toast.hidden)).toHaveLength(5);
  });

  test("clearing a task removes its toast", () => {
    showProgressToast("task", { title: "Working" });
    clearProgressToast("task");

    expect(store.toasts).toEqual([]);
  });
});
