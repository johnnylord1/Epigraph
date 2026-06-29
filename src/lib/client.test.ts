import { afterEach, describe, expect, test, vi } from "vitest";

import { gql, gqlUpload } from "./client";

describe("GraphQL client errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("normalizes empty GraphQL errors from JSON requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: null, errors: [{ message: "" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    await expect(gql("query EmptyError { noop }")).rejects.toThrow(
      "Suwayomi returned an empty GraphQL error.",
    );
  });

  test("normalizes empty GraphQL errors from upload requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: null, errors: [{ message: " " }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    await expect(gqlUpload(
      "mutation Upload($extensionFile: Upload!) { installExternalExtension(input: { extensionFile: $extensionFile }) { extension { pkgName } } }",
      { extensionFile: null },
      { "variables.extensionFile": new File(["apk"], "source.apk") },
    )).rejects.toThrow("Suwayomi returned an empty GraphQL error.");
  });
});
