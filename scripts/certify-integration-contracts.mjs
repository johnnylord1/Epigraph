import { createVerification, sanitize } from './verification-evidence.mjs';
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(process.cwd());
const pnpmCli = process.env.npm_execpath;

const declarations = [
  { id: 'deterministic TypeScript contracts', kind: 'verification' },
  { id: 'Suwayomi updater certification', kind: 'verification', condition: 'EPIGRAPH_SKIP_SUWAYOMI_CERTIFICATION != 1' },
  { id: 'native updater policy', kind: 'verification' },
].map(stage => ({ ...stage, name: stage.id }));
const evidence = createVerification({ runner: 'certify-integration-contracts.mjs', stages: declarations,
  scope: { environment: 'deterministic', journeys: ['Listed integration contract tests only'], backend: { kind: 'mock' } } });
let activeStage;

function run(label, executable, args, extraEnv = {}) {
  activeStage = label; evidence.beginStage(label);
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
  evidence.stage(label, "PASS", { exitCode: result.status }); activeStage = null;
}

try {
if (!pnpmCli) throw new Error("pnpm CLI path is unavailable; run this gate through pnpm.");

run("deterministic TypeScript contracts", process.execPath, [
  pnpmCli,
  "exec",
  "vitest",
  "run",
  "--project",
  "unit",
  "src/lib/epigraphUpdater.test.ts",
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

if (process.env.EPIGRAPH_SKIP_SUWAYOMI_CERTIFICATION !== "1") {
  run("Suwayomi updater certification", process.execPath, ["--test", "scripts/certify-suwayomi-release.test.mjs"]);
} else {
  evidence.stage("Suwayomi updater certification", "SKIPPED", { reason: "Explicit skip requested; no separate certification is inferred" });
}
run(
  "native updater policy",
  process.platform === "win32" ? "cargo.exe" : "cargo",
  ["test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", "stable_release_policy_excludes", "--", "--nocapture"],
  { CARGO_BUILD_JOBS: "1" },
);

process.stdout.write("\n[release integrations] all deterministic contracts passed\n");

} catch (error) {
  if (activeStage) evidence.stage(activeStage, 'FAIL', { reason: error.message });
  else evidence.r.failures.push({ location: 'runner', reason: sanitize(error.message) });
  evidence.diagnostic('integration failure', error.message);
  process.exitCode = 1;
} finally {
  const result = evidence.finish();
  console.log(`Verification receipt: ${evidence.file}`);
  if (result.outcome === 'FAIL') process.exitCode = 1;
}
