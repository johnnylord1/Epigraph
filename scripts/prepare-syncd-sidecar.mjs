import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const srcTauriDir = path.join(projectRoot, "src-tauri");
const extension = process.platform === "win32" ? ".exe" : "";

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
const sourceBinary = path.join(srcTauriDir, "target", "debug", `aethon-syncd${extension}`);
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
  ["build", "--manifest-path", path.join(srcTauriDir, "Cargo.toml"), "--bin", "aethon-syncd"],
  { cwd: projectRoot, stdio: "inherit" },
);

fs.copyFileSync(sourceBinary, targetBinary);

console.log(`Prepared syncd sidecar: ${targetBinary}`);
