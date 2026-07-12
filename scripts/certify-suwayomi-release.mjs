import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";

const REPOSITORY = "Suwayomi/Suwayomi-Server";
const CHECKSUM_ASSET = "Checksums.sha256";
const DEFAULT_TIMEOUT_MS = 120_000;
const QUERY_CHECKS = [
  ["typename", "query AethonHealthTypename { __typename }"],
  ["library", "query AethonHealthLibrary { library: mangas(condition: { inLibrary: true }, first: 1) { nodes { id } } }"],
  ["sources", "query AethonHealthSources { sources(first: 1) { nodes { id displayName } } }"],
  ["extensions", "query AethonHealthExtensions { extensions(first: 1) { nodes { pkgName isInstalled } } }"],
];

export function normalizeVersion(value) {
  const normalized = String(value ?? "").trim();
  if (!/^v\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error("Version must use the Suwayomi vMAJOR.MINOR.REVISION format.");
  }
  return normalized;
}

export function checksumForAsset(text, assetName) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[2] === assetName) return match[1].toLowerCase();
  }
  throw new Error(`Checksum file does not contain ${assetName}.`);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readJarVersion(bytes) {
  const archive = await JSZip.loadAsync(bytes);
  const entry = archive.file("META-INF/MANIFEST.MF");
  if (!entry) throw new Error("JAR does not contain META-INF/MANIFEST.MF.");
  const manifest = await entry.async("string");
  const version = manifest.match(/^Specification-Version:\s*(.+)$/mi)?.[1]?.trim();
  if (!version) throw new Error("JAR manifest does not declare Specification-Version.");
  return version;
}

export function buildAllowlistCandidate({ version, asset, sha256: certifiedSha256, platforms }) {
  return {
    version,
    asset,
    sha256: certifiedSha256,
    notes: `Certified by Aethon's managed-runtime gate on ${platforms.join(" and ")}.`,
  };
}

export function validateHealthPayload(payload, expectedKey) {
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error("GraphQL returned errors.");
  }
  if (!payload?.data) throw new Error("GraphQL response is missing data.");
  if (expectedKey === "typename") {
    if (typeof payload.data.__typename !== "string" || !payload.data.__typename.trim()) {
      throw new Error("GraphQL response is missing __typename.");
    }
    return;
  }
  if (!Array.isArray(payload.data[expectedKey]?.nodes)) {
    throw new Error(`GraphQL ${expectedKey} response is missing its nodes array.`);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function assertOfficialAssetUrl(url, version) {
  const parsed = new URL(url);
  const expectedPrefix = `/${REPOSITORY}/releases/download/${version}/`;
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !parsed.pathname.startsWith(expectedPrefix)) {
    throw new Error(`Release asset is not an official ${REPOSITORY} HTTPS URL.`);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Aethon-Suwayomi-Certification",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`GitHub release lookup returned HTTP ${response.status}.`);
  return response.json();
}

async function downloadBytes(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Aethon-Suwayomi-Certification" } });
  if (!response.ok) throw new Error(`Release download returned HTTP ${response.status}.`);
  return Buffer.from(await response.arrayBuffer());
}

function javaExecutable(explicit) {
  if (explicit) return path.resolve(explicit);
  if (!process.env.JAVA_HOME) return "java";
  return path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java");
}

function serverConfig(port) {
  return [
    'server.ip = "127.0.0.1"',
    `server.port = ${port}`,
    "server.webUIEnabled = false",
    "server.initialOpenInBrowserEnabled = false",
    "server.systemTrayEnabled = false",
    "server.debugLogsEnabled = false",
    "server.globalUpdateInterval = 0",
    "server.webUIUpdateCheckInterval = 0",
    "server.autoDownloadNewChapters = false",
    "server.maxSourcesInParallel = 2",
    "server.extensionRepos = []",
    "",
  ].join("\n");
}

function startRuntime(java, jarPath, rootDir) {
  const args = [
    `-Dsuwayomi.tachidesk.config.server.rootDir=${rootDir}`,
    "-Djava.awt.headless=true",
    "-Xms96m",
    "-Xmx512m",
    "-XX:+UseG1GC",
    "-noverify",
    "-jar",
    jarPath,
  ];
  const child = spawn(java, args, { cwd: rootDir, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  let spawnError = null;
  const collect = (chunk) => {
    output.push(...String(chunk).split(/\r?\n/).filter(Boolean));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", (error) => {
    spawnError = error;
    collect(error.message);
  });
  return { child, output, get spawnError() { return spawnError; } };
}

async function stopRuntime(child) {
  if (!child.pid || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function runHealthCheck(endpoint, expectedKey, query) {
  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  validateHealthPayload(payload, expectedKey);
  return Date.now() - started;
}

async function waitForHealth(endpoint, runtime, timeoutMs) {
  const started = Date.now();
  const checks = [];
  let attempt = 0;
  let lastError = "Runtime did not become healthy.";
  while (Date.now() - started < timeoutMs) {
    if (runtime.spawnError) throw new Error(`Could not start Suwayomi: ${runtime.spawnError.message}`);
    if (runtime.child.exitCode !== null) throw new Error(`Suwayomi exited before becoming healthy (code ${runtime.child.exitCode}).`);
    attempt += 1;
    let passed = true;
    for (const [name, query] of QUERY_CHECKS) {
      try {
        const durationMs = await runHealthCheck(endpoint, name, query);
        checks.push({ attempt, check: name, ok: true, durationMs });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        checks.push({ attempt, check: name, ok: false, durationMs: 0, error: lastError });
        passed = false;
        break;
      }
    }
    if (passed) return { attempts: attempt, elapsedMs: Date.now() - started, checks };
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw Object.assign(new Error(`GraphQL health timed out: ${lastError}`), { checks });
}

async function certifyRuntime({ java, jarPath, rootDir, endpoint, timeoutMs }) {
  const runs = [];
  for (const phase of ["initial", "restart"]) {
    const runtime = startRuntime(java, jarPath, rootDir);
    const started = Date.now();
    try {
      const health = await waitForHealth(endpoint, runtime, timeoutMs);
      runs.push({ phase, ok: true, durationMs: Date.now() - started, ...health });
    } catch (error) {
      runs.push({
        phase,
        ok: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
        checks: error?.checks ?? [],
        output: runtime.output,
      });
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { runs });
    } finally {
      await stopRuntime(runtime.child);
    }
  }
  return runs;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = normalizeVersion(options.version);
  const port = Number.parseInt(options.port ?? "45679", 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535.");
  const timeoutMs = Number.parseInt(options["timeout-ms"] ?? String(DEFAULT_TIMEOUT_MS), 10);
  const artifactDir = path.resolve(options["artifact-dir"] ?? path.join("tmp", "suwayomi-certification", `${version}-${process.platform}-${process.arch}`));
  await mkdir(artifactDir, { recursive: true });
  const reportPath = path.join(artifactDir, "certification-report.json");
  const candidatePath = path.join(artifactDir, "allowlist-candidate.json");
  const report = {
    schemaVersion: 1,
    repository: REPOSITORY,
    version,
    platform: process.platform,
    arch: process.arch,
    startedAt: new Date().toISOString(),
    passed: false,
    runs: [],
  };
  let runtimeRoot;
  try {
    const release = await fetchJson(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${version}`);
    if (release.draft || release.prerelease) throw new Error("Draft and prerelease builds cannot be certified.");
    const assetName = `Suwayomi-Server-${version}.jar`;
    const jarAsset = release.assets?.find((asset) => asset.name === assetName);
    const checksumAsset = release.assets?.find((asset) => asset.name === CHECKSUM_ASSET);
    if (!jarAsset || !checksumAsset) throw new Error("Release is missing the expected JAR or checksum asset.");
    assertOfficialAssetUrl(jarAsset.browser_download_url, version);
    assertOfficialAssetUrl(checksumAsset.browser_download_url, version);
    const checksumBytes = await downloadBytes(checksumAsset.browser_download_url);
    const expectedSha256 = checksumForAsset(checksumBytes.toString("utf8"), assetName);
    const jarBytes = options.jar ? await readFile(path.resolve(options.jar)) : await downloadBytes(jarAsset.browser_download_url);
    const actualSha256 = sha256(jarBytes);
    if (actualSha256 !== expectedSha256) throw new Error("Downloaded JAR does not match the published checksum.");
    const jarVersion = normalizeVersion(await readJarVersion(jarBytes));
    if (jarVersion !== version) throw new Error(`JAR declares ${jarVersion}, expected ${version}.`);
    runtimeRoot = await mkdtemp(path.join(tmpdir(), "aethon-suwayomi-certification-"));
    const jarPath = path.join(runtimeRoot, assetName);
    await writeFile(jarPath, jarBytes);
    await writeFile(path.join(runtimeRoot, "server.conf"), serverConfig(port));
    report.releaseUrl = release.html_url;
    report.asset = assetName;
    report.sha256 = actualSha256;
    report.jarVersion = jarVersion;
    report.runs = await certifyRuntime({
      java: javaExecutable(options.java),
      jarPath,
      rootDir: runtimeRoot,
      endpoint: `http://127.0.0.1:${port}/api/graphql`,
      timeoutMs,
    });
    report.passed = true;
    await writeFile(candidatePath, `${JSON.stringify(buildAllowlistCandidate({
      version,
      asset: assetName,
      sha256: actualSha256,
      platforms: [`${process.platform}-${process.arch}`],
    }), null, 2)}\n`);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    if (Array.isArray(error?.runs)) report.runs = error.runs;
    process.exitCode = 1;
  } finally {
    if (runtimeRoot) {
      try {
        await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
      } catch (error) {
        report.cleanupError = error instanceof Error ? error.message : String(error);
        report.error ??= "Certification runtime residue could not be cleaned safely.";
        report.passed = false;
        process.exitCode = 1;
      }
    }
    report.completedAt = new Date().toISOString();
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (!report.passed) throw new Error(report.error ?? "Certification failed.");
  process.stdout.write(`Suwayomi ${version} certified on ${process.platform}-${process.arch}.\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
