import { afterEach, describe, expect, it } from "vitest";
import {
  configureBuiltInLocalServerPorts,
  createCustomLocalProfile,
  DEFAULT_LOCAL_PROFILE_ID,
  fallbackBuiltInServerPorts,
  getAllLocalProfiles,
  getLocalProfileMeta,
  localProfileDisplayName,
  resolveSessionProfile,
} from "./localProfiles";

describe("resolveSessionProfile", () => {
  it("uses the persisted default profile for a normal session", () => {
    const resolved = resolveSessionProfile(null, "main", "http://127.0.0.1:4667");

    expect(resolved.profileId).toBe("main");
    expect(resolved.profileMeta?.serverUrl).toBe("http://127.0.0.1:4567");
    expect(resolved.effectiveServerUrl).toBe("http://127.0.0.1:4567");
    expect(resolved.isOverrideSession).toBe(false);
    expect(resolved.resolutionSource).toBe("settings-default");
  });

  it("normalizes an invalid stored profile id to the safe default", () => {
    const resolved = resolveSessionProfile(null, "broken-profile", null);

    expect(resolved.profileId).toBe(DEFAULT_LOCAL_PROFILE_ID);
    expect(resolved.profileMeta).toEqual(getLocalProfileMeta(DEFAULT_LOCAL_PROFILE_ID));
    expect(resolved.resolutionSource).toBe("invalid-default-fallback");
  });

  it("resolves the hidden test profile when it is the stored default", () => {
    const resolved = resolveSessionProfile(null, "test", null);

    expect(resolved.profileId).toBe("test");
    expect(resolved.profileMeta).toEqual(getLocalProfileMeta("test"));
    expect(resolved.resolutionSource).toBe("settings-default");
  });

  it("treats explicit launch overrides as session-only runtime resolution", () => {
    const resolved = resolveSessionProfile({
      serverUrlOverride: "http://127.0.0.1:4567",
      profileLabelOverride: "MAIN",
    }, "test", "http://127.0.0.1:4667");

    expect(resolved.profileId).toBe("main");
    expect(resolved.launchProfileOverride).toBe("main");
    expect(resolved.isOverrideSession).toBe(true);
    expect(resolved.resolutionSource).toBe("launch-override");
    expect(resolved.effectiveServerUrl).toBe("http://127.0.0.1:4567");
  });

  it("marks attach-only audit launches as override sessions while preserving the stored default", () => {
    const resolved = resolveSessionProfile({
      attachOnlyOverride: true,
      auditOpenOverride: "settings-security",
    }, "test", "http://127.0.0.1:4667");

    expect(resolved.profileId).toBe("test");
    expect(resolved.profileMeta?.label).toBe("TEST");
    expect(resolved.isOverrideSession).toBe(true);
    expect(resolved.attachOnly).toBe(true);
    expect(resolved.effectiveServerUrl).toBe("http://127.0.0.1:4667");
  });

  it("does not fake a built-in profile for a custom override URL", () => {
    const resolved = resolveSessionProfile({
      serverUrlOverride: "http://10.0.0.25:8080",
    }, "test", "http://127.0.0.1:4667");

    expect(resolved.profileId).toBeNull();
    expect(resolved.profileMeta).toBeNull();
    expect(resolved.displayLabel).toContain("CUSTOM");
    expect(resolved.effectiveServerUrl).toBe("http://10.0.0.25:8080");
  });

  it("exposes only main as the built-in visible profile", () => {
    expect(getAllLocalProfiles().map((profile) => profile.id)).toEqual(["main"]);
    expect(getLocalProfileMeta("test")?.label).toBe("TEST");
  });

  it("creates and resolves custom local profiles", () => {
    const custom = createCustomLocalProfile({ label: "Sandbox", port: 4877 });
    const resolved = resolveSessionProfile(null, custom.id, null, [custom]);

    expect(custom).toEqual({ id: "sandbox", label: "Sandbox", port: 4877 });
    expect(getAllLocalProfiles([custom]).map((profile) => profile.id)).toContain("sandbox");
    expect(resolved.profileId).toBe("sandbox");
    expect(resolved.profileMeta?.serverUrl).toBe("http://127.0.0.1:4877");
    expect(resolved.displayLabel).toBe("Sandbox");
  });

  it("rejects duplicate custom profile ports", () => {
    const custom = createCustomLocalProfile({ label: "Sandbox", port: 4877 });

    expect(() => createCustomLocalProfile({ label: "Other", port: 4877 }, [custom])).toThrow("already used");
    expect(() => createCustomLocalProfile({ label: "Main Copy", port: 4567 }, [custom])).toThrow("already used");
  });

  it("keeps profiles off the ports of the Core and of a debug build", () => {
    for (const port of [4777, 4787, 4577, 4677]) {
      expect(() => createCustomLocalProfile({ label: "Sandbox", port })).toThrow("already used");
    }
  });
});

describe("configureBuiltInLocalServerPorts", () => {
  afterEach(() => configureBuiltInLocalServerPorts({ main: 4567, test: 4667 }));

  it("follows a debug build's ports instead of the installed release's", () => {
    configureBuiltInLocalServerPorts({ main: 4577, test: 4677 });

    expect(resolveSessionProfile(null, "main").effectiveServerUrl).toBe("http://127.0.0.1:4577");
    expect(getLocalProfileMeta("test")).toMatchObject({ port: 4677, title: "TEST :4677" });
  });

  it("keeps the release ports when the Core reports nothing usable", () => {
    configureBuiltInLocalServerPorts(null);
    configureBuiltInLocalServerPorts({ main: 0, test: "nope" });

    expect(getLocalProfileMeta("main")?.serverUrl).toBe("http://127.0.0.1:4567");
    expect(getLocalProfileMeta("test")?.port).toBe(4667);
  });

  it("keeps the Vite dev page off the release ports when it runs outside Tauri", () => {
    configureBuiltInLocalServerPorts(fallbackBuiltInServerPorts("development"));

    expect(getLocalProfileMeta("main")?.serverUrl).toBe("http://127.0.0.1:4577");
    expect(getLocalProfileMeta("test")?.port).toBe(4677);
  });

  it("has no fallback for a production build or the test runner", () => {
    expect(fallbackBuiltInServerPorts("production")).toBeNull();
    expect(fallbackBuiltInServerPorts("test")).toBeNull();
    expect(fallbackBuiltInServerPorts(undefined)).toBeNull();
  });
});

describe("localProfileDisplayName", () => {
  const translate = (key: string) => `t:${key}`;

  it("shows built-in and unnamed profiles by their translated names", () => {
    expect(localProfileDisplayName("MAIN", translate)).toBe("t:settings.general.profiles.builtinMain");
    expect(localProfileDisplayName(" test ", translate)).toBe("t:settings.general.profiles.builtinTest");
    expect(localProfileDisplayName("CUSTOM", translate)).toBe("t:settings.general.profiles.unnamed");
    expect(localProfileDisplayName(null, translate)).toBe("t:settings.general.profiles.unnamed");
  });

  it("keeps the name people gave their own profiles", () => {
    expect(localProfileDisplayName(" Laptop ", translate)).toBe("Laptop");
  });
});
