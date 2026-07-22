import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.cwd());
const pnpmCli = process.env.npm_execpath;

function sanitize(output) {
  return String(output ?? "")
    .replaceAll(root, "<workspace>")
    .replaceAll(root.replaceAll("\\", "/"), "<workspace>")
    .replaceAll(homedir(), "<home>")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/((?:api[_ -]?key|token|cookie|authorization)[\s\"']*[:=][\s\"']*)[^\s,\"'}]+/gi, "$1[redacted]");
}

function run(label, executable, args, extraEnv = {}) {
  process.stdout.write(`\n[release integrations] ${label}\n`);
  const result = spawnSync(executable, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = sanitize(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  process.stdout.write(output);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}.`);
}

if (!pnpmCli) throw new Error("pnpm CLI path is unavailable; run this gate through pnpm.");

run("deterministic TypeScript contracts", process.execPath, [
  pnpmCli,
  "exec",
  "vitest",
  "run",
  "--project",
  "unit",
  "src/lib/aethonUpdater.test.ts",
  "src/lib/releaseIntegrationContract.test.ts",
  "src/lib/trackerOAuth.test.ts",
  "src/lib/proxySettings.test.ts",
  "src/lib/flaresolverr.test.ts",
  "src/lib/novels/hardcover.test.ts",
  "src/lib/novels/hardcoverTransport.test.ts",
  "src/lib/discord/discordPresence.test.ts",
  "src/lib/discord/discordCoverService.test.ts",
  "src/lib/discord/discordPublicCoverResolver.test.ts",
  "src/lib/discord/openLibraryCoverResolver.test.ts",
  "src/lib/discord/trackerCoverResolver.test.ts",
  "--maxWorkers=1",
  "--minWorkers=1",
]);

if (process.env.AETHON_SKIP_SUWAYOMI_CERTIFICATION !== "1") {
  run("Suwayomi updater certification", process.execPath, ["--test", "scripts/certify-suwayomi-release.test.mjs"]);
} else {
  console.log("[release integrations] Suwayomi updater certification skipped by the aggregate gate (already certified separately)");
}
run(
  "native updater policy",
  process.platform === "win32" ? "cargo.exe" : "cargo",
  ["test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "stable_release_policy_excludes", "--", "--nocapture"],
  { CARGO_BUILD_JOBS: "1" },
);

process.stdout.write("\n[release integrations] all deterministic contracts passed\n");
