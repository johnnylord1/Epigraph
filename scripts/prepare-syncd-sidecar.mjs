import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const srcTauriDir = path.join(projectRoot, "src-tauri");
const extension = process.platform === "win32" ? ".exe" : "";
const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";

function hostTuple() {
  try {
    return execSync("rustc --print host-tuple", { cwd: projectRoot, encoding: "utf8" }).trim();
  } catch {
    const verbose = execSync("rustc -Vv", { cwd: projectRoot, encoding: "utf8" });
    const hostLine = verbose
      .split(/\r?\n/)
      .find((line) => line.toLowerCase().startsWith("host:"));
    if (!hostLine) {
      throw new Error("Unable to determine Rust host target triple");
    }
    return hostLine.split(/\s+/)[1].trim();
  }
}

const targetTriple = hostTuple();
const sourceBinary = path.join(srcTauriDir, "target", profile, `aethon-syncd${extension}`);
const binariesDir = path.join(srcTauriDir, "binaries");
const targetBinary = path.join(
  binariesDir,
  `aethon-syncd-${targetTriple}${extension}`,
);

fs.mkdirSync(binariesDir, { recursive: true });
if (!fs.existsSync(targetBinary)) {
  fs.closeSync(fs.openSync(targetBinary, "w"));
}

execFileSync(
  "cargo",
  [
    "build",
    ...(release ? ["--release"] : []),
    "--manifest-path",
    path.join(srcTauriDir, "Cargo.toml"),
    "--bin",
    "aethon-syncd",
  ],
  { cwd: projectRoot, stdio: "inherit" },
);

fs.copyFileSync(sourceBinary, targetBinary);

const size = fs.statSync(targetBinary).size;
if (size < 1024 * 1024) {
  throw new Error(`Prepared syncd sidecar is unexpectedly small (${size} bytes)`);
}
const smokeDataDir = path.join(projectRoot, "tmp", "syncd-sidecar-build-smoke-missing");
execFileSync(
  targetBinary,
  ["shutdown", "--data-dir", smokeDataDir, "--timeout-seconds", "1"],
  { cwd: projectRoot, stdio: "inherit" },
);

console.log(`Prepared ${profile} syncd sidecar: ${targetBinary}`);
