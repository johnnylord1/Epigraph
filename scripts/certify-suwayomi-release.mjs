import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import JSZip from "jszip";

const REPOSITORY = "Suwayomi/Suwayomi-Server";
const CHECKSUM_ASSET = "Checksums.sha256";
const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_CERTIFICATION_VERSION = "v2.3.2243";
export const RUNTIME_CONTRACT = Object.freeze({
  requiredQueries: ["aboutServer", "extensionStores", "extensions", "mangas", "sources"],
  requiredMutations: [
    "addExtensionStore",
    "removeExtensionStore",
    "fetchExtensions",
    "updateExtension",
    "fetchSourceManga",
    "fetchManga",
    "fetchChapters",
    "fetchChapterPages",
  ],
  requiredFields: {
    ExtensionType: [
      "pkgName",
      "name",
      "lang",
      "versionName",
      "versionCodeLong",
      "isInstalled",
      "isObsolete",
      "hasUpdate",
      "iconUrl",
      "storeIndexUrl",
      "apkName",
      "apkUrl",
      "jarUrl",
    ],
    ExtensionStoreType: [
      "name",
      "badgeLabel",
      "signingKey",
      "contactWebsite",
      "contactDiscord",
      "indexUrl",
      "isLegacy",
      "extensionListUrl",
    ],
    SourceType: [
      "id",
      "name",
      "lang",
      "displayName",
      "iconUrl",
      "isNsfw",
      "supportsLatest",
      "isConfigurable",
      "extension",
    ],
  },
  optionalCapabilities: [
    "extensionStores",
    "legacyExtensionRepositories",
    "extensionInstallMutation",
    "extensionUpdateMutation",
    "extensionUninstallMutation",
    "sourcePreferences",
    "webViewOperations",
  ],
});
const QUERY_CHECKS = [
  ["typename", "query AethonHealthTypename { __typename }"],
  ["library", "query AethonHealthLibrary { library: mangas(condition: { inLibrary: true }, first: 1) { nodes { id } } }"],
  ["sources", "query AethonHealthSources { sources(first: 1) { nodes { id displayName } } }"],
  ["extensions", "query AethonHealthExtensions { extensions(first: 1) { nodes { pkgName isInstalled } } }"],
];
const SCHEMA_QUERY = `
  query AethonRuntimeSchema {
    __schema {
      queryType { name }
      mutationType { name }
      subscriptionType { name }
      types {
        kind
        name
        fields(includeDeprecated: true) {
          name
          args {
            name
            type {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType {
                    kind
                    name
                    ofType { kind name }
                  }
                }
              }
            }
          }
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType { kind name }
                }
              }
            }
          }
        }
        inputFields {
          name
          type {
            kind
            name
            ofType {
              kind
              name
              ofType {
                kind
                name
                ofType {
                  kind
                  name
                  ofType { kind name }
                }
              }
            }
          }
        }
        enumValues(includeDeprecated: true) { name }
        possibleTypes { kind name }
      }
    }
  }
`;
const execFileAsync = promisify(execFile);

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

function normalizeTypeRef(type) {
  if (!type || typeof type !== "object") return null;
  return {
    kind: typeof type.kind === "string" ? type.kind : null,
    name: typeof type.name === "string" ? type.name : null,
    ofType: normalizeTypeRef(type.ofType),
  };
}

function sortByName(values) {
  return [...(Array.isArray(values) ? values : [])].sort((left, right) =>
    String(left?.name ?? "").localeCompare(String(right?.name ?? "")),
  );
}

function schemaValue(payload) {
  const schema = payload?.data?.__schema ?? payload?.__schema ?? payload;
  if (!schema || !Array.isArray(schema.types)) {
    throw new Error("GraphQL introspection response is missing schema types.");
  }
  return schema;
}

export function canonicalizeSchema(payload) {
  const schema = schemaValue(payload);
  const canonical = {
    queryType: schema.queryType?.name ?? null,
    mutationType: schema.mutationType?.name ?? null,
    subscriptionType: schema.subscriptionType?.name ?? null,
    types: sortByName(schema.types).map((type) => ({
      kind: type.kind ?? null,
      name: type.name ?? null,
      fields: sortByName(type.fields).map((field) => ({
        name: field.name ?? null,
        args: sortByName(field.args).map((argument) => ({
          name: argument.name ?? null,
          type: normalizeTypeRef(argument.type),
        })),
        type: normalizeTypeRef(field.type),
      })),
      inputFields: sortByName(type.inputFields).map((field) => ({
        name: field.name ?? null,
        type: normalizeTypeRef(field.type),
      })),
      enumValues: sortByName(type.enumValues).map((value) => value.name ?? null),
      possibleTypes: sortByName(type.possibleTypes).map((value) => ({
        kind: value.kind ?? null,
        name: value.name ?? null,
      })),
    })),
  };
  return JSON.stringify(canonical);
}

function schemaIndex(payload) {
  const schema = schemaValue(payload);
  const types = new Map(schema.types.map((type) => [type.name, type]));
  const queryType = types.get(schema.queryType?.name);
  const mutationType = types.get(schema.mutationType?.name);
  const queryFields = new Set((queryType?.fields ?? []).map((field) => field.name));
  const mutationFields = new Set((mutationType?.fields ?? []).map((field) => field.name));
  const fieldPaths = [];
  for (const type of schema.types) {
    for (const field of type.fields ?? []) {
      fieldPaths.push(`${type.name}.${field.name}`);
    }
    for (const field of type.inputFields ?? []) {
      fieldPaths.push(`${type.name}.${field.name}`);
    }
  }
  return { schema, types, queryFields, mutationFields, fieldPaths };
}

function capabilityEvidence(index, pattern, source = index.fieldPaths) {
  return source.filter((value) => pattern.test(value)).sort().slice(0, 20);
}

export function evaluateRuntimeSchema(payload) {
  const index = schemaIndex(payload);
  const requiredQueries = RUNTIME_CONTRACT.requiredQueries.map((name) => ({
    name,
    present: index.queryFields.has(name),
  }));
  const requiredMutations = RUNTIME_CONTRACT.requiredMutations.map((name) => ({
    name,
    present: index.mutationFields.has(name),
  }));
  const requiredFields = Object.entries(RUNTIME_CONTRACT.requiredFields).flatMap(([typeName, fields]) => {
    const available = new Set((index.types.get(typeName)?.fields ?? []).map((field) => field.name));
    return fields.map((name) => ({ type: typeName, name, present: available.has(name) }));
  });
  const mutationPaths = [...index.mutationFields].map((name) => `Mutation.${name}`);
  const capabilityPatterns = {
    extensionStores: /extensionstores?/i,
    legacyExtensionRepositories: /extensionrepos(itories)?/i,
    extensionInstallMutation: /(?:install.*extension|extension.*install)/i,
    extensionUpdateMutation: /(?:update.*extension|extension.*update)/i,
    extensionUninstallMutation: /(?:(?:uninstall|delete).*extension|extension.*(?:uninstall|delete))/i,
    sourcePreferences: /source.*preferences?/i,
    webViewOperations: /webview/i,
  };
  const capabilities = Object.fromEntries(
    Object.entries(capabilityPatterns).map(([name, pattern]) => {
      const source = name.endsWith("Mutation") ? mutationPaths : index.fieldPaths;
      const evidence = capabilityEvidence(index, pattern, source);
      return [name, { observed: evidence.length > 0, evidence }];
    }),
  );
  return {
    contract: {
      passed: [...requiredQueries, ...requiredMutations, ...requiredFields].every((entry) => entry.present),
      requiredQueries,
      requiredMutations,
      requiredFields,
    },
    capabilities,
    counts: {
      types: index.schema.types.length,
      queryFields: index.queryFields.size,
      mutationFields: index.mutationFields.size,
    },
    operations: {
      queries: [...index.queryFields].sort(),
      mutations: [...index.mutationFields].sort(),
    },
  };
}

export function redactDiagnosticText(value, sensitiveValues = []) {
  let redacted = String(value ?? "");
  const replacements = [
    [homedir(), "<user-home>"],
    [tmpdir(), "<temp-dir>"],
    ...sensitiveValues.map((item) => [String(item ?? ""), "<runtime-root>"]),
  ]
    .filter(([item]) => item)
    .sort((left, right) => right[0].length - left[0].length);
  for (const [sensitive, replacement] of replacements) {
    const variants = [sensitive, sensitive.replaceAll("\\", "/")];
    for (const variant of variants) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      redacted = redacted.replace(new RegExp(escaped, "gi"), replacement);
    }
  }
  return redacted
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1<redacted>@")
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\b\s*[:=]\s*[^\r\n]+/gi, "$1=<redacted>")
    .replace(/(["']?)(password|secret|token)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$2=<redacted>");
}

function redactDiagnosticValue(value, sensitiveValues = []) {
  if (typeof value === "string") return redactDiagnosticText(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((entry) => redactDiagnosticValue(entry, sensitiveValues));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactDiagnosticValue(entry, sensitiveValues)]),
    );
  }
  return value;
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

export function buildCompatibilityReview({ version, asset, sha256: certifiedSha256, platforms }) {
  return {
    schemaVersion: 1,
    reviewOnly: true,
    promotionEligible: false,
    executionIsolation: "disposable-profile-only",
    version,
    asset,
    artifactSha256: certifiedSha256,
    platforms,
    notes: "Compatibility evidence only. Promotion requires the supervised SR7 data, extension, rollback, and ownership gates.",
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

export async function allocateLoopbackPort() {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string" || !Number.isInteger(address.port)) {
      throw new Error("Could not allocate a candidate loopback port.");
    }
    return address.port;
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function listeningProcessIds(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Candidate port is invalid.");
  }
  if (process.platform === "win32") {
    const command = [
      `$owners = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)`,
      "$owners -join [Environment]::NewLine",
    ].join("\n");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: 5_000, windowsHide: true },
    );
    return stdout.split(/\r?\n/).map(Number).filter((value) => Number.isInteger(value) && value > 0);
  }

  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeout: 5_000 },
    );
    return stdout.split(/\r?\n/).map(Number).filter((value) => Number.isInteger(value) && value > 0);
  } catch (error) {
    if (error?.code === 1) return [];
    throw new Error("Could not verify candidate port ownership on this platform.", { cause: error });
  }
}

export async function assertPortOwnedByProcess(port, pid) {
  const owners = await listeningProcessIds(port);
  if (owners.length !== 1 || owners[0] !== pid) {
    throw new Error("Candidate GraphQL port is not owned exclusively by the launched Suwayomi process.");
  }
}

async function waitForPortRelease(port, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listeningProcessIds(port)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Candidate GraphQL port remained occupied after shutdown.");
}

export function serverConfig(port, { extensionRepos = [], extensionStores = [] } = {}) {
  const stores = extensionStores.length > 0
    ? `server.extensionStores = ${JSON.stringify(extensionStores)}`
    : `server.extensionRepos = ${JSON.stringify(extensionRepos)}`;
  return [
    'server.ip = "127.0.0.1"',
    `server.port = ${port}`,
    "server.webUIEnabled = false",
    "server.initialOpenInBrowserEnabled = false",
    "server.systemTrayEnabled = false",
    "server.kcefEnabled = false",
    "server.debugLogsEnabled = false",
    "server.globalUpdateInterval = 0",
    "server.webUIUpdateCheckInterval = 0",
    "server.autoDownloadNewChapters = false",
    "server.maxSourcesInParallel = 1",
    stores,
    "",
  ].join("\n");
}

export function startRuntime(java, jarPath, rootDir) {
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

export async function stopRuntime(child, port) {
  if (child.pid && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }
  await waitForPortRelease(port);
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

export async function graphqlRequest(endpoint, query, timeoutMs = 10_000) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GraphQL request returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error("GraphQL introspection returned errors.");
  }
  return payload;
}

export async function sampleProcessMetrics(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { available: false, error: "Process ID is unavailable." };
  try {
    if (process.platform === "win32") {
      const command = [
        `$process = Get-Process -Id ${pid} -ErrorAction Stop`,
        "$metrics = [ordered]@{",
        "  workingSetBytes = [int64]$process.WorkingSet64",
        "  privateMemoryBytes = [int64]$process.PrivateMemorySize64",
        "  virtualMemoryBytes = [int64]$process.VirtualMemorySize64",
        "  threadCount = [int]$process.Threads.Count",
        "  cpuSeconds = [double]$process.CPU",
        "  startTimeUtc = $process.StartTime.ToUniversalTime().ToString('o')",
        "}",
        "$metrics | ConvertTo-Json -Compress",
      ].join("\n");
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { timeout: 5_000, windowsHide: true },
      );
      return {
        available: true,
        sampledAt: new Date().toISOString(),
        source: "Get-Process",
        ...JSON.parse(stdout.trim()),
      };
    }
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "rss=,vsz=", "-p", String(pid)],
      { timeout: 5_000 },
    );
    const [rssKb, virtualKb] = stdout.trim().split(/\s+/).map(Number);
    if (![rssKb, virtualKb].every(Number.isFinite)) {
      throw new Error("Process metrics output is incomplete.");
    }
    return {
      available: true,
      sampledAt: new Date().toISOString(),
      source: "ps",
      workingSetBytes: rssKb * 1024,
      virtualMemoryBytes: virtualKb * 1024,
    };
  } catch (error) {
    return {
      available: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function collectRuntimeBaseline(endpoint, pid) {
  const payload = await graphqlRequest(endpoint, SCHEMA_QUERY);
  const canonicalSchema = canonicalizeSchema(payload);
  const evaluation = evaluateRuntimeSchema(payload);
  if (!evaluation.contract.passed) {
    throw new Error("Runtime schema does not satisfy Aethon's baseline semantic contract.");
  }
  return {
    schema: {
      canonicalSha256: sha256(canonicalSchema),
      canonicalBytes: Buffer.byteLength(canonicalSchema),
      ...evaluation.counts,
      operations: evaluation.operations,
    },
    contract: evaluation.contract,
    capabilities: evaluation.capabilities,
    process: await sampleProcessMetrics(pid),
  };
}

export async function waitForHealth(endpoint, runtime, timeoutMs) {
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

async function certifyRuntime({ java, jarPath, rootDir, endpoint, port, timeoutMs }) {
  const runs = [];
  for (const phase of ["initial", "restart"]) {
    const runtime = startRuntime(java, jarPath, rootDir);
    const started = Date.now();
    try {
      const health = await waitForHealth(endpoint, runtime, timeoutMs);
      await assertPortOwnedByProcess(port, runtime.child.pid);
      const baseline = await collectRuntimeBaseline(endpoint, runtime.child.pid);
      runs.push({ phase, ok: true, durationMs: Date.now() - started, ...health, baseline });
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
      await stopRuntime(runtime.child, port);
    }
  }
  return runs;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = normalizeVersion(options.version ?? DEFAULT_CERTIFICATION_VERSION);
  const requestedPort = options.port === undefined ? null : Number.parseInt(options.port, 10);
  if (requestedPort !== null && (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535)) {
    throw new Error("Port must be between 1024 and 65535.");
  }
  const timeoutMs = Number.parseInt(options["timeout-ms"] ?? String(DEFAULT_TIMEOUT_MS), 10);
  const artifactDir = path.resolve(options["artifact-dir"] ?? path.join("tmp", "suwayomi-certification", `${version}-${process.platform}-${process.arch}`));
  await mkdir(artifactDir, { recursive: true });
  const reportPath = path.join(artifactDir, "certification-report.json");
  const reviewPath = path.join(artifactDir, "compatibility-review.json");
  await rm(reviewPath, { force: true });
  const report = {
    schemaVersion: 2,
    repository: REPOSITORY,
    version,
    targetPolicy: options.version ? "explicit-manual" : "fixed-sr1-default",
    productionAllowlistChanged: false,
    promotionEligible: false,
    executionIsolation: "disposable-profile-only",
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
    const port = requestedPort ?? await allocateLoopbackPort();
    const jarPath = path.join(runtimeRoot, assetName);
    await writeFile(jarPath, jarBytes);
    await writeFile(path.join(runtimeRoot, "server.conf"), serverConfig(port));
    report.releaseUrl = release.html_url;
    report.asset = assetName;
    report.assetBytes = jarBytes.byteLength;
    report.sha256 = actualSha256;
    report.jarVersion = jarVersion;
    report.portPolicy = requestedPort === null ? "dynamic-loopback" : "explicit-loopback";
    report.runs = await certifyRuntime({
      java: javaExecutable(options.java),
      jarPath,
      rootDir: runtimeRoot,
      endpoint: `http://127.0.0.1:${port}/api/graphql`,
      port,
      timeoutMs,
    });
    const [firstRun, restartRun] = report.runs;
    report.baseline = {
      profile: "disposable-empty",
      schema: firstRun?.baseline?.schema ?? null,
      contract: firstRun?.baseline?.contract ?? null,
      capabilities: firstRun?.baseline?.capabilities ?? null,
      processRuns: report.runs.map((run) => ({
        phase: run.phase,
        durationMs: run.durationMs,
        attempts: run.attempts,
        process: run.baseline?.process ?? null,
      })),
      restartStable: Boolean(
        firstRun?.baseline?.schema?.canonicalSha256
        && firstRun.baseline.schema.canonicalSha256 === restartRun?.baseline?.schema?.canonicalSha256
        && restartRun?.baseline?.contract?.passed,
      ),
    };
    if (!report.baseline.restartStable) {
      throw new Error("Runtime schema or semantic contract changed after restart.");
    }
    report.passed = true;
    await writeFile(reviewPath, `${JSON.stringify(buildCompatibilityReview({
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
    const safeReport = redactDiagnosticValue(report, [runtimeRoot]);
    await writeFile(reportPath, `${JSON.stringify(safeReport, null, 2)}\n`);
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
