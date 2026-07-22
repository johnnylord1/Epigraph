import { describe, expect, it } from "vitest";

import { normalizeSocksProxyInput } from "./proxySettings";

const valid = {
  enabled: true,
  host: " 127.0.0.1 ",
  port: " 1080 ",
  version: 5,
  username: "",
  password: "",
};

describe("SOCKS proxy configuration", () => {
  it("normalizes a valid anonymous proxy", () => {
    expect(normalizeSocksProxyInput(valid)).toMatchObject({ host: "127.0.0.1", port: "1080", version: 5 });
  });

  it("accepts disabled incomplete settings without sending credentials", () => {
    expect(normalizeSocksProxyInput({ ...valid, enabled: false, host: "", port: "" }).enabled).toBe(false);
  });

  it.each([
    [{ ...valid, host: "" }, "host"],
    [{ ...valid, port: "0" }, "port"],
    [{ ...valid, port: "65536" }, "port"],
    [{ ...valid, port: "not-a-port" }, "port"],
    [{ ...valid, version: 6 }, "version"],
    [{ ...valid, username: "user" }, "together"],
    [{ ...valid, password: "secret" }, "together"],
  ])("rejects invalid enabled configuration", (input, message) => {
    expect(() => normalizeSocksProxyInput(input)).toThrow(message);
  });
});
