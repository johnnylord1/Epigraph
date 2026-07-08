import { cleanup, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import NocturneState from "./NocturneState.svelte";

function readProjectFile(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function tokensDefinedIn(source: string) {
  return new Set(
    [...source.matchAll(/(--component-nocturne-state-[\w-]+)\s*:/g)].map((match) => match[1]),
  );
}

function tokensConsumedIn(source: string) {
  return new Set(
    [...source.matchAll(/var\((--component-nocturne-state-[\w-]+)/g)].map((match) => match[1]),
  );
}

describe("NocturneState theme tokens", () => {
  afterEach(() => cleanup());

  test("renders semantic layouts, tones, and actions", () => {
    const onClick = vi.fn();

    render(NocturneState, {
      props: {
        layout: "compact",
        tone: "danger",
        icon: "warning",
        eyebrow: "Audit",
        title: "Tokenized state",
        body: "The state component renders without direct visual values.",
        detail: "Detail text",
        actions: [
          { label: "Retry", kind: "primary", icon: "retry", onClick },
          { label: "Delete", kind: "danger", disabled: true, onClick },
        ],
      },
    });

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Audit")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("keeps the component free of direct visual values", () => {
    const source = readProjectFile("src/components/shared/NocturneState.svelte");
    const style = source.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const directVisualPattern =
      /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|linear-gradient\(|radial-gradient\(|--n-/;
    const directEffectPattern =
      /^(box-shadow|filter|backdrop-filter|-webkit-backdrop-filter|z-index|border-radius|opacity)\s*:\s*([^;]+);?$/;

    expect(style, "NocturneState styles should consume tokens instead of direct colors").not.toMatch(directVisualPattern);

    const directEffects = style
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => {
        const match = line.match(directEffectPattern);
        if (!match) return false;
        const [, prop, value] = match;
        if (value.includes("var(")) return false;
        if (prop === "opacity") return /0\.\d/.test(value);
        return true;
      });

    expect(directEffects).toEqual([]);
  });

  test("defines and consumes every component token", () => {
    const component = readProjectFile("src/components/shared/NocturneState.svelte");
    const tokens = readProjectFile("src/styles/tokens.css");
    const nocturne = readProjectFile("src/styles/nocturne-theme.css");
    const baseDefinitions = tokensDefinedIn(tokens);
    const consumed = tokensConsumedIn(component);
    const nocturneDefinitions = tokensDefinedIn(nocturne);

    const unused = [...baseDefinitions].filter((token) => !consumed.has(token)).sort();
    const undefinedBase = [...consumed].filter((token) => !baseDefinitions.has(token)).sort();
    const missingNocturne = [...consumed].filter((token) => !nocturneDefinitions.has(token)).sort();

    expect(consumed.size).toBeGreaterThan(0);
    expect(unused, "all --component-nocturne-state-* tokens should be consumed").toEqual([]);
    expect(undefinedBase, "all consumed tokens should be defined in tokens.css").toEqual([]);
    expect(missingNocturne, "all consumed tokens should be implemented by Nocturne").toEqual([]);
  });
});
