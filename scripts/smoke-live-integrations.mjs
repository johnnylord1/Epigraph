const enabled = process.env.EPIGRAPH_RELEASE_SMOKE_LIVE === "1";

if (!enabled) {
  process.stdout.write("Live integration smoke skipped. Set EPIGRAPH_RELEASE_SMOKE_LIVE=1 with explicit disposable endpoints to opt in.\n");
  process.exit(0);
}

const configuredTargets = [
  ["FlareSolverr", process.env.EPIGRAPH_LIVE_FLARESOLVERR_URL],
  ["Suwayomi", process.env.EPIGRAPH_LIVE_SUWAYOMI_URL],
].filter(([, value]) => Boolean(value));

if (configuredTargets.length === 0) {
  throw new Error("Live smoke was enabled, but no disposable integration endpoint was configured.");
}

for (const [name, rawUrl] of configuredTargets) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} endpoint must use HTTP or HTTPS.`);
  }
  process.stdout.write(`${name}: configured for optional live smoke (endpoint redacted).\n`);
}

process.stdout.write("Live targets passed configuration validation. No credentials were read or printed.\n");
