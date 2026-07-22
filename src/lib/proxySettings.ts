export interface SocksProxyInput {
  enabled: boolean;
  host: string;
  port: string;
  version: number;
  username: string;
  password: string;
}

export interface NormalizedSocksProxyInput extends SocksProxyInput {
  port: string;
  version: 4 | 5;
}

export function normalizeSocksProxyInput(input: SocksProxyInput): NormalizedSocksProxyInput {
  const normalized = {
    enabled: input.enabled,
    host: input.host.trim(),
    port: input.port.trim(),
    version: input.version,
    username: input.username.trim(),
    password: input.password.trim(),
  };

  if (normalized.version !== 4 && normalized.version !== 5) {
    throw new Error("SOCKS version must be 4 or 5.");
  }
  if (!normalized.enabled) return normalized as NormalizedSocksProxyInput;
  if (!normalized.host) throw new Error("SOCKS host is required when the proxy is enabled.");
  if (!/^\d+$/.test(normalized.port)) throw new Error("SOCKS port must be a number between 1 and 65535.");
  const port = Number(normalized.port);
  if (port < 1 || port > 65535) throw new Error("SOCKS port must be a number between 1 and 65535.");
  if (Boolean(normalized.username) !== Boolean(normalized.password)) {
    throw new Error("SOCKS username and password must be provided together.");
  }

  return normalized as NormalizedSocksProxyInput;
}
