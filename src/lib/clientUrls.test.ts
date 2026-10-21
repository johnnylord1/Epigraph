import { describe, expect, it, vi } from "vitest";

vi.mock("./startupClient", () => ({ getServerUrl: () => "http://127.0.0.1:4567" }));

import { serverFileUrl, thumbUrl } from "./clientUrls";

describe("clientUrls", () => {
  it("prefixes server paths", () => {
    expect(thumbUrl("/api/v1/manga/1/thumbnail")).toBe("http://127.0.0.1:4567/api/v1/manga/1/thumbnail");
    expect(serverFileUrl("files/a.png")).toBe("http://127.0.0.1:4567/files/a.png");
  });

  it("keeps inline and absolute covers as they are", () => {
    for (const url of ["data:image/png;base64,AAAA", "blob:http://x/1", "asset://localhost/c.png", "https://x.test/c.jpg", "HTTP://x.test/c.jpg"]) {
      expect(thumbUrl(url)).toBe(url);
      expect(serverFileUrl(url)).toBe(url);
    }
  });
});
