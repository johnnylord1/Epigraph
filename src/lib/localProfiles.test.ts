import { describe, expect, it } from "vitest";
import {
  createCustomLocalProfile,
  DEFAULT_LOCAL_PROFILE_ID,
  getAllLocalProfiles,
  getLocalProfileMeta,
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

  it("marks attach-only audit launches as override sessions without rewriting the default target", () => {
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
    const custom = createCustomLocalProfile({ label: "Sandbox", port: 4777 });
    const resolved = resolveSessionProfile(null, custom.id, null, [custom]);

    expect(custom).toEqual({ id: "sandbox", label: "Sandbox", port: 4777 });
    expect(getAllLocalProfiles([custom]).map((profile) => profile.id)).toContain("sandbox");
    expect(resolved.profileId).toBe("sandbox");
    expect(resolved.profileMeta?.serverUrl).toBe("http://127.0.0.1:4777");
    expect(resolved.displayLabel).toBe("Sandbox");
  });

  it("rejects duplicate custom profile ports", () => {
    const custom = createCustomLocalProfile({ label: "Sandbox", port: 4777 });

    expect(() => createCustomLocalProfile({ label: "Other", port: 4777 }, [custom])).toThrow("already used");
    expect(() => createCustomLocalProfile({ label: "Main Copy", port: 4567 }, [custom])).toThrow("already used");
  });
});