import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

function readProjectFile(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

function reducedMotionBlocks(source: string) {
  const blocks: string[] = [];
  let index = source.indexOf("@media (prefers-reduced-motion: reduce)");
  while (index >= 0) {
    const open = source.indexOf("{", index);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      if (source[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(source.slice(open, end + 1));
    index = source.indexOf("@media (prefers-reduced-motion: reduce)", end);
  }
  return blocks;
}

function keyframes(source: string, name: string) {
  const start = source.indexOf(`@keyframes ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}\n", source.indexOf("50%", start)) + 1);
}

const REDUCED = 'html[data-epigraph-reduced-motion="true"]';

describe("startup splash with reduced motion", () => {
  // Windows with animation effects turned off reports reduced motion, and so does the app's own
  // Animations switch; the loading line then has to keep signalling progress without moving,
  // instead of freezing mid-sweep.
  test("the app splash loading line keeps breathing in place", () => {
    const port = readProjectFile("src/styles/nocturne-port.css");
    expect(port).toContain(`${REDUCED} .epigraph-port--splash *,`);
    expect(port).toMatch(
      /html\[data-epigraph-reduced-motion="true"\] \.epigraph-port--splash \.line span \{[^}]*animation: epigraph-splash-breathe [^;]*infinite !important;/,
    );
    expect(port).not.toContain("@media (prefers-reduced-motion: reduce)");
    const breathe = keyframes(port, "epigraph-splash-breathe");
    expect(breathe).toContain("opacity");
    expect(breathe).not.toContain("transform");
  });

  test("the boot splash loading line keeps breathing in place", () => {
    const html = readProjectFile("index.html");
    const block = reducedMotionBlocks(html).find((candidate) => candidate.includes(".boot-splash__line::after"));
    expect(block).toBeDefined();
    expect(block).toMatch(/\.boot-splash__line::after \{[^}]*animation: boot-splash-breathe [^;]*infinite;/);
    const breathe = keyframes(html, "boot-splash-breathe");
    expect(breathe).toContain("opacity");
    expect(breathe).not.toContain("transform");
  });
});

describe("splash while the UI motion rests", () => {
  // After five quiet seconds the app marks motion idle. Idle only pauses a few looping decorations;
  // the lock splash lives inside the shell and must keep its loading line moving.
  test("the idle pause of the app shell leaves the splash animating", () => {
    const app = readProjectFile("src/App.svelte");
    const port = readProjectFile("src/styles/nocturne-port.css");

    expect(app).not.toContain('[data-epigraph-motion="idle"] .epigraph-app-shell *:not(');
    const idleSplashSelectors = port
      .split("\n")
      .filter((line) => line.includes('[data-epigraph-motion="idle"]') && line.includes("epigraph-port--splash"));
    expect(idleSplashSelectors).toEqual(['html[data-epigraph-motion="idle"] .epigraph-port--splash .brand-mark {']);
  });
});
