import { describe, expect, it } from "vitest";
import { toSuwayomiWebViewUrl } from "./suwayomiWebView";

describe("suwayomiWebView", () => {
  it("builds the internal Suwayomi WebView wrapper URL with an encoded source URL hash", () => {
    expect(
      toSuwayomiWebViewUrl(
        "http://127.0.0.1:4667",
        "https://example.com/chapter?id=1&name=A B",
      ),
    ).toBe(
      "http://127.0.0.1:4667/api/v1/webview?lang=en#https%3A%2F%2Fexample.com%2Fchapter%3Fid%3D1%26name%3DA%20B",
    );
  });

  it("normalizes server paths to the WebView endpoint", () => {
    expect(
      toSuwayomiWebViewUrl(
        "http://127.0.0.1:4667/api/graphql",
        "https://example.com/read",
      ),
    ).toBe(
      "http://127.0.0.1:4667/api/v1/webview?lang=en#https%3A%2F%2Fexample.com%2Fread",
    );
  });
});
