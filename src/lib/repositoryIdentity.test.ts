import { describe, expect, it } from "vitest";
import { repositoryAvatar, repositoryLabel } from "./repositoryIdentity";

describe("repository identity", () => {
  it("names GitHub repositories by owner and repo", () => {
    expect(repositoryLabel("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json")).toBe("keiyoushi/extensions");
    expect(repositoryLabel("https://github.com/yuzono/manga-repo")).toBe("yuzono/manga-repo");
  });

  it("falls back to the host, or the text when it is not a URL", () => {
    expect(repositoryLabel("https://cdn.example.test/repo/index.json")).toBe("cdn.example.test");
    expect(repositoryLabel("not a url")).toBe("not a url");
  });

  it("uses the GitHub owner's avatar only for GitHub URLs", () => {
    expect(repositoryAvatar("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json")).toBe("https://github.com/keiyoushi.png?size=64");
    expect(repositoryAvatar("https://cdn.example.test/repo/index.json")).toBeNull();
    expect(repositoryAvatar("https://github.com/")).toBeNull();
    expect(repositoryAvatar("not a url")).toBeNull();
  });
});
