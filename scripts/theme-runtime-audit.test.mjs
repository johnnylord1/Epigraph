import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_THEME_IDS,
  computedContrastRatio,
  parseComputedColor,
  parseRuntimeAuditArgs,
} from "./theme-runtime-audit.mjs";

test("runtime audit arguments default to the complete builtin matrix", () => {
  const options = parseRuntimeAuditArgs([]);
  assert.equal(options.cdp, "http://127.0.0.1:9223");
  assert.deepEqual(options.themes, BUILTIN_THEME_IDS);
  assert.equal(options.themes.length, 8);
  assert.ok(options.themes.includes("amoled"));
});

test("runtime audit arguments accept an explicit output and theme subset", () => {
  const options = parseRuntimeAuditArgs(["--out", "tmp/audit", "--themes", "nocturne,light"]);
  assert.equal(options.out, "tmp/audit");
  assert.deepEqual(options.themes, ["nocturne", "light"]);
  assert.throws(() => parseRuntimeAuditArgs(["--themes", "unknown"]), /Unknown builtin theme/);
});

test("computed color and alpha-aware contrast follow WCAG math", () => {
  assert.deepEqual(parseComputedColor("rgba(255, 255, 255, 0.62)"), {
    red: 255,
    green: 255,
    blue: 255,
    alpha: 0.62,
  });
  assert.equal(Number(computedContrastRatio("rgb(255, 255, 255)", "rgb(0, 0, 0)").toFixed(2)), 21);
  assert.ok(computedContrastRatio("rgba(255, 255, 255, 0.62)", "rgb(19, 19, 22)") >= 4.5);
  assert.ok(computedContrastRatio("rgb(229, 226, 225)", "rgba(255, 255, 255, 0.035)", "rgb(19, 19, 19)") >= 4.5);
});
