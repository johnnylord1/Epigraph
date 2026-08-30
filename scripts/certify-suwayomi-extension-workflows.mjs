import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
  allocateLoopbackPort,
  assertPortOwnedByProcess,
  graphqlRequest,
  serverConfig,
  sha256,
  startRuntime,
  stopRuntime,
  waitForHealth,
} from "./certify-suwayomi-release.mjs";

const ARTIFACT_CACHE_PREFIX = "epigraph-suwayomi-artifact-";

export const WORKFLOW_CANDIDATE = Object.freeze({
  version: "v2.3.2243",
  url: "https://github.com/Suwayomi/Suwayomi-Server/releases/download/v2.3.2243/Suwayomi-Server-v2.3.2243.jar",
  sha256: "821141b32e170d4a02d3cbdfed577ed8f07bd22383ff5f4132ebb5ae40e98dd5",
});

export const WORKFLOW_BASELINE = Object.freeze({
  version: "v2.1.1867",
  url: "https://github.com/Suwayomi/Suwayomi-Server/releases/download/v2.1.1867/Suwayomi-Server-v2.1.1867.jar",
  sha256: "51e307c2581e4e1a002991ab3e3a77503c8b074c42695987a984a7382d0ac5af",
});

export const STRUCTURAL_CANARY = Object.freeze({
  packageName: "eu.kanade.tachiyomi.extension.all.akuma",
  versionCode: "7",
  versionName: "1.4.7",
  fileName: "tachiyomi-all.akuma-v1.4.7.apk",
  url: "https://raw.githubusercontent.com/keiyoushi/extensions/c29058d23ef0e515a91acb70f92987ada1838846/apk/tachiyomi-all.akuma-v1.4.7.apk",
  sha256: "a449e87e4636451d5f80a600366e07f621cdb8e231835d11abca136862015081",
});

export const DIRECT_INSTALL_CANARY = Object.freeze({
  packageName: "eu.kanade.tachiyomi.extension.all.akuma",
  versionCode: "10",
  versionName: "1.4.10",
  fileName: "tachiyomi-all.akuma-v1.4.10.jar",
  storeCommit: "193dffcb8505b83858759e53f23e9157e708fd6b",
  url: "https://raw.githubusercontent.com/keiyoushi/extensions/193dffcb8505b83858759e53f23e9157e708fd6b/jar/tachiyomi-all.akuma-v1.4.10.jar",
  sha256: "6dc723db4b10eabfd006978b54407faec410405c5b23d213ebfc90fe3bb23d6d",
});

const STRUCTURAL_ERROR_PATTERN = /(?:LinkageError|AbstractMethodError|NoSuchMethodError|NoSuchFieldError|IncompatibleClassChangeError|NoClassDefFoundError|ClassNotFoundException|VerifyError|UnsupportedClassVersionError|does not implement[^\n]*kotlin\.jvm\.functions|cannot be cast to okhttp3\.|ClassCastException[^\n]*(?:kotlin|okhttp))/i;
const EXTENSION_REGISTRATION_ATTEMPTS = 90;
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zr0sAAAAASUVORK5CYII=",
  "base64",
);

function installExternalExtensionMutation(v23) {
  const versionField = v23 ? "versionCodeLong" : "versionCode";
  return `
  mutation EpigraphInstallCertificationExtension($extensionFile: Upload!) {
    installExternalExtension(input: { extensionFile: $extensionFile }) {
      extension { pkgName versionName ${versionField} isInstalled }
    }
  }
`;
}
const INVENTORY_QUERY = `
  query EpigraphCertificationInventory {
    extensions { nodes { pkgName versionName versionCodeLong isInstalled } }
    sources { nodes { id name lang displayName extension { pkgName } } }
  }
`;
const LOCAL_SEARCH = `
  mutation EpigraphCertificationSearch($source: LongString!) {
    fetchSourceManga(input: { source: $source, type: POPULAR, page: 1 }) {
      mangas { id title sourceId }
      hasNextPage
    }
  }
`;
const LOCAL_DETAILS = `
  mutation EpigraphCertificationDetails($id: Int!) {
    fetchManga(input: { id: $id }) {
      manga { id title description author artist genre realUrl sourceId }
    }
  }
`;
const LOCAL_CHAPTERS = `
  mutation EpigraphCertificationChapters($mangaId: Int!) {
    fetchChapters(input: { mangaId: $mangaId }) {
      chapters { id mangaId name sourceOrder pageCount }
    }
  }
`;
const LOCAL_PAGES = `
  mutation EpigraphCertificationPages($chapterId: Int!) {
    fetchChapterPages(input: { chapterId: $chapterId }) { pages }
  }
`;
const REFRESH_EXTENSIONS = `
  mutation EpigraphRefreshCertificationExtensions {
    fetchExtensions(input: {}) {
      extensions { pkgName versionName versionCodeLong isInstalled jarUrl }
    }
  }
`;
const INSTALL_STORE_EXTENSION = `
  mutation EpigraphInstallCertificationStoreExtension($id: String!) {
    updateExtension(input: { id: $id, patch: { install: true } }) {
      extension { pkgName versionName versionCodeLong isInstalled }
    }
  }
`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
    }
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function errorChain(error) {
  const messages = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : null;
  }
  return [...new Set(messages.filter(Boolean))].join(": ");
}

export function assertNoStructuralRuntimeErrors(lines) {
  const match = lines.find((line) => STRUCTURAL_ERROR_PATTERN.test(String(line)));
  if (match) throw new Error("The candidate emitted a structural extension compatibility error.");
}

async function downloadPinnedFile(url, destination, expectedSha256) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) throw new Error(`Pinned artifact download returned HTTP ${response.status}.`);
      const digest = createHash("sha256");
      const counter = { bytes: 0 };
      const hasher = new Transform({
        transform(chunk, _encoding, callback) {
          counter.bytes += chunk.length;
          digest.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), hasher, createWriteStream(destination, { flags: "wx" }));
      const actual = digest.digest("hex");
      if (actual !== expectedSha256) throw new Error("Pinned artifact SHA-256 does not match the certification policy.");
      return { bytes: counter.bytes, sha256: actual };
    } catch (error) {
      lastError = error;
      await rm(destination, { force: true });
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(`Pinned artifact download failed: ${errorChain(lastError)}`, { cause: lastError });
}

async function isValidPinnedFile(filePath, expectedSha256) {
  try {
    return sha256(await readFile(filePath)) === expectedSha256;
  } catch {
    return false;
  }
}

async function pruneArtifactCache(cacheRoot, maxFiles = 8) {
  const entries = await readdir(cacheRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(cacheRoot, entry.name);
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(ARTIFACT_CACHE_PREFIX)) continue;
    const details = await stat(filePath);
    if (entry.name.endsWith(".tmp")) {
      if (Date.now() - details.mtimeMs > 86_400_000) await rm(filePath, { force: true });
      continue;
    }
    files.push({ filePath, mtimeMs: details.mtimeMs });
  }
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);
  await Promise.all(files.slice(maxFiles).map(({ filePath }) => rm(filePath, { force: true })));
}

export async function ensurePinnedFile(explicitPath, _root, descriptor) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!await isValidPinnedFile(resolved, descriptor.sha256)) {
      throw new Error("Explicit artifact SHA-256 does not match the certification policy.");
    }
    return resolved;
  }
  const cacheRoot = path.resolve(
    process.env.EPIGRAPH_SUWAYOMI_ARTIFACT_CACHE
      || path.join(tmpdir(), "epigraph-suwayomi-artifact-cache-v1"),
  );
  await mkdir(cacheRoot, { recursive: true });
  const extension = path.extname(descriptor.fileName ?? new URL(descriptor.url).pathname);
  const destination = path.join(cacheRoot, `${ARTIFACT_CACHE_PREFIX}${descriptor.sha256}${extension}`);
  if (await isValidPinnedFile(destination, descriptor.sha256)) {
    await pruneArtifactCache(cacheRoot);
    return destination;
  }
  await rm(destination, { force: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  try {
    await downloadPinnedFile(descriptor.url, temporary, descriptor.sha256);
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!await isValidPinnedFile(destination, descriptor.sha256)) throw error;
      await rm(temporary, { force: true });
    }
    await pruneArtifactCache(cacheRoot);
    return destination;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function graphqlOperation(endpoint, query, variables = {}, timeoutMs = 20_000) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GraphQL operation returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error(`GraphQL operation failed: ${payload.errors.map((item) => item.message).join("; ")}`);
  }
  return payload.data;
}

async function installCanary(endpoint, artifactPath, v23, descriptor = STRUCTURAL_CANARY) {
  const bytes = await readFile(artifactPath);
  const form = new FormData();
  form.append("operations", JSON.stringify({ query: installExternalExtensionMutation(v23), variables: { extensionFile: null } }));
  form.append("map", JSON.stringify({ 0: ["variables.extensionFile"] }));
  const fileName = path.basename(artifactPath);
  const contentType = fileName.endsWith(".jar") ? "application/java-archive" : "application/vnd.android.package-archive";
  form.append("0", new Blob([bytes], { type: contentType }), fileName);
  const response = await fetch(endpoint, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Extension upload returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (Array.isArray(payload?.errors) && payload.errors.length) {
    throw new Error(`Extension upload failed: ${payload.errors.map((item) => item.message).join("; ")}`);
  }
  const extension = payload?.data?.installExternalExtension?.extension;
  if (extension?.pkgName !== descriptor.packageName || extension?.isInstalled !== true) {
    throw new Error("Suwayomi did not register the pinned extension canary.");
  }
}

async function installStoreCanary(endpoint, descriptor, expectedJarUrl) {
  const refreshed = await graphqlOperation(endpoint, REFRESH_EXTENSIONS, {}, 30_000);
  const available = refreshed.fetchExtensions?.extensions?.find(
    (item) => item.pkgName === descriptor.packageName,
  );
  if (
    !available
    || String(available.versionCodeLong) !== descriptor.versionCode
    || available.jarUrl !== expectedJarUrl
  ) {
    throw new Error("The deterministic Extension Store did not expose the pinned JAR.");
  }
  const installed = await graphqlOperation(endpoint, INSTALL_STORE_EXTENSION, {
    id: descriptor.packageName,
  }, 30_000);
  const extension = installed.updateExtension?.extension;
  if (
    extension?.pkgName !== descriptor.packageName
    || String(extension.versionCodeLong) !== descriptor.versionCode
    || extension.isInstalled !== true
  ) {
    throw new Error("Suwayomi did not install the deterministic store extension.");
  }
}

async function refreshStoreExtensions(endpoint) {
  await graphqlOperation(endpoint, REFRESH_EXTENSIONS, {}, 30_000);
}

export async function startFixtureStoreServer(artifactPath, descriptor) {
  const artifact = await readFile(artifactPath);
  let indexJson = "";
  const requests = [];
  const server = createServer((request, response) => {
    const requestUrl = request.url ?? "/";
    requests.push(requestUrl);
    if (requestUrl === "/index.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(indexJson);
      return;
    }
    if (requestUrl === "/fixture.jar") {
      response.writeHead(200, {
        "content-type": "application/java-archive",
        "content-length": String(artifact.byteLength),
      });
      response.end(artifact);
      return;
    }
    if (requestUrl === "/icon.png") {
      response.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(PNG_1X1.byteLength),
      });
      response.end(PNG_1X1);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("The deterministic Extension Store did not bind to loopback.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const jarUrl = `${baseUrl}/fixture.jar`;
  indexJson = `${JSON.stringify({
    name: "Epigraph Certification",
    badgeLabel: "Fixture",
    signingKey: "",
    contact: {
      website: baseUrl,
      discord: null,
    },
    extensionList: {
      extensions: [{
        name: "Akuma",
        packageName: descriptor.packageName,
        resources: {
          apkUrl: "",
          iconUrl: `${baseUrl}/icon.png`,
          jarUrl,
        },
        extensionLib: "1.4",
        versionCode: Number(descriptor.versionCode),
        versionName: descriptor.versionName,
        contentWarning: "NSFW",
        sources: [{
          id: 7,
          name: "Akuma",
          language: "all",
          homeUrl: "https://akuma.moe",
          mirrorUrls: [],
          message: null,
        }],
      }],
    },
    extensionListUrl: null,
  }, null, 2)}\n`;
  return {
    indexUrl: `${baseUrl}/index.json`,
    jarUrl,
    requests,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function collectInstalledExtensionIdentityOnce(endpoint, descriptor) {
  const inventory = await graphqlOperation(endpoint, INVENTORY_QUERY);
  const extension = inventory.extensions?.nodes?.find(
    (item) => item.pkgName === descriptor.packageName,
  );
  const sourceIds = inventory.sources?.nodes
    ?.filter((source) => source.extension?.pkgName === descriptor.packageName)
    .map((source) => String(source.id))
    .sort() ?? [];
  if (
    !extension
    || extension.isInstalled !== true
    || String(extension.versionCodeLong) !== descriptor.versionCode
    || sourceIds.length === 0
  ) {
    const observed = extension
      ? `installed=${String(extension.isInstalled)}, versionCode=${String(extension.versionCodeLong)}, sources=${sourceIds.join(",") || "<none>"}`
      : "extension=<missing>";
    throw new Error(`The exact V23 extension artifact did not register its expected sources (${observed}).`);
  }
  return {
    packageName: extension.pkgName,
    versionName: extension.versionName,
    versionCode: String(extension.versionCodeLong),
    sourceIds,
  };
}

async function collectInstalledExtensionIdentity(endpoint, descriptor) {
  let lastError = null;
  for (let attempt = 0; attempt < EXTENSION_REGISTRATION_ATTEMPTS; attempt += 1) {
    try {
      return await collectInstalledExtensionIdentityOnce(endpoint, descriptor);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < EXTENSION_REGISTRATION_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  throw lastError ?? new Error("The exact V23 extension identity did not become ready.");
}

async function waitForPinnedExtensionJar(root, expectedSha256, timeoutMs = 15_000) {
  const extensionsDir = path.join(root, "extensions");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await readdir(extensionsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jar")) continue;
      const filePath = path.join(extensionsDir, entry.name);
      if (sha256(await readFile(filePath)) === expectedSha256) {
        return { fileName: entry.name, sha256: expectedSha256 };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The exact V23 extension JAR was not durably materialized before restart.");
}

export async function findGeneratedCanaryJar(root) {
  const extensionsDir = path.join(root, "extensions");
  const candidates = (await readdir(extensionsDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jar"))
    .map((entry) => path.join(extensionsDir, entry.name));
  if (candidates.length !== 1) {
    const names = candidates.map((candidate) => path.basename(candidate)).join(", ") || "<none>";
    throw new Error(`The clean baseline profile produced ${candidates.length} extension JARs: ${names}.`);
  }
  return {
    path: candidates[0],
    sha256: sha256(await readFile(candidates[0])),
  };
}

async function defaultJavaExecutable() {
  if (process.env.EPIGRAPH_SUWAYOMI_JAVA) return process.env.EPIGRAPH_SUWAYOMI_JAVA;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const bundled = path.join(process.env.LOCALAPPDATA, "epigraph", "binaries", "suwayomi-bundle", "jre", "bin", "java.exe");
    try {
      await access(bundled);
      return bundled;
    } catch {
      // Fall through to PATH for development environments without a managed bundle.
    }
  }
  return "java";
}

export async function defaultBaselineJar() {
  if (process.env.EPIGRAPH_SUWAYOMI_BASELINE_JAR) return process.env.EPIGRAPH_SUWAYOMI_BASELINE_JAR;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const bundled = path.join(
      process.env.LOCALAPPDATA,
      "epigraph",
      "binaries",
      "suwayomi-bundle",
      "bin",
      "Suwayomi-Server.jar",
    );
    try {
      await access(bundled);
      if (await isValidPinnedFile(bundled, WORKFLOW_BASELINE.sha256)) return bundled;
    } catch {
      // The release artifact is downloaded below when no managed baseline exists.
    }
  }
  return null;
}

export async function createLocalSourceFixture(root) {
  const mangaRoot = path.join(root, "local", "Epigraph Certification");
  const chapterRoot = path.join(mangaRoot, "Chapter 01");
  await mkdir(chapterRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(mangaRoot, "cover.jpg"), PNG_1X1),
    writeFile(path.join(chapterRoot, "page01.png"), PNG_1X1),
    writeFile(path.join(mangaRoot, "details.json"), `${JSON.stringify({
      title: "Epigraph Certification",
      author: "Epigraph",
      artist: "Epigraph",
      description: "Deterministic local source certification fixture.",
      genre: ["Certification"],
      status: "2",
    }, null, 2)}\n`),
  ]);
}

export function summarizeDeterministicWorkflow({ inventory, search, details, chapters, pages }) {
  const extension = inventory?.extensions?.nodes?.find((item) => item.pkgName === STRUCTURAL_CANARY.packageName);
  const extensionSources = inventory?.sources?.nodes?.filter(
    (item) => item.extension?.pkgName === STRUCTURAL_CANARY.packageName,
  ) ?? [];
  const localSource = inventory?.sources?.nodes?.find(
    (item) => String(item.id) === "0" || /^local$/i.test(String(item.name)),
  );
  const manga = search?.fetchSourceManga?.mangas?.[0];
  const detail = details?.fetchManga?.manga;
  const chapter = chapters?.fetchChapters?.chapters?.[0];
  const pageList = pages?.fetchChapterPages?.pages;
  if (!extension?.isInstalled || extensionSources.length === 0) throw new Error("Pinned extension canary did not register a source.");
  if (!localSource || manga?.title !== "Epigraph Certification") throw new Error("Deterministic Local Source search failed.");
  if (detail?.title !== manga.title || detail?.author !== "Epigraph") throw new Error("Deterministic Local Source details failed.");
  if (!chapter || chapter.mangaId !== manga.id) throw new Error("Deterministic Local Source chapters failed.");
  if (!Array.isArray(pageList) || pageList.length !== 1) throw new Error("Deterministic Local Source pages failed.");
  return {
    extension: {
      packageName: STRUCTURAL_CANARY.packageName,
      versionCode: String(extension.versionCodeLong),
      sourceIds: extensionSources.map((item) => String(item.id)).sort(),
    },
    localSourceId: String(localSource.id),
    localManga: {
      title: manga.title,
      author: detail.author,
    },
    localChapter: {
      name: chapter.name ?? null,
      sourceOrder: chapter.sourceOrder ?? null,
      pageCount: chapter.pageCount ?? null,
    },
    pageCount: pageList.length,
  };
}

export async function waitForMatchingWorkflow(
  expected,
  collect,
  { attempts = 10, intervalMs = 500 } = {},
) {
  let actual = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    actual = await collect();
    if (JSON.stringify(actual) === JSON.stringify(expected)) return actual;
    if (attempt + 1 < attempts && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(
    `Deterministic workflow identity did not stabilize after restart. candidate=${JSON.stringify(expected)} restart=${JSON.stringify(actual)}`,
  );
}

async function collectWorkflow(endpoint) {
  const inventoryPayload = await graphqlRequest(endpoint, INVENTORY_QUERY, 20_000);
  const inventory = inventoryPayload.data;
  const localSource = inventory.sources.nodes.find(
    (item) => String(item.id) === "0" || /^local$/i.test(String(item.name)),
  );
  if (!localSource) throw new Error("Suwayomi Local Source is not registered.");
  const search = await graphqlOperation(endpoint, LOCAL_SEARCH, { source: String(localSource.id) });
  const manga = search.fetchSourceManga?.mangas?.[0];
  if (!manga) throw new Error("Suwayomi Local Source returned no deterministic manga.");
  const details = await graphqlOperation(endpoint, LOCAL_DETAILS, { id: manga.id });
  const chapters = await graphqlOperation(endpoint, LOCAL_CHAPTERS, { mangaId: manga.id });
  const chapter = chapters.fetchChapters?.chapters?.[0];
  if (!chapter) throw new Error("Suwayomi Local Source returned no deterministic chapter.");
  const pages = await graphqlOperation(endpoint, LOCAL_PAGES, { chapterId: chapter.id });
  return summarizeDeterministicWorkflow({ inventory, search, details, chapters, pages });
}

async function assertNoRuntimeForRoot(root) {
  if (process.platform !== "win32") return;
  const escaped = root.replaceAll("'", "''");
  const command = `$matches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('java.exe','javaw.exe') -and $_.CommandLine -like '*${escaped}*' }); if ($matches.Count) { exit 9 }`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    stdio: "ignore",
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  if (code !== 0) throw new Error("A candidate JVM remained after shutdown.");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tempRoot = await mkdtemp(path.join(tmpdir(), "epigraph-suwayomi-workflow-"));
  const runtimeRoot = path.join(tempRoot, "profile");
  const artifactDir = options["artifact-dir"] ? path.resolve(options["artifact-dir"]) : null;
  const timeoutMs = Number.parseInt(options["timeout-ms"] ?? "120000", 10);
  const java = options.java ?? await defaultJavaExecutable();
  const report = {
    schemaVersion: 1,
    candidateVersion: WORKFLOW_CANDIDATE.version,
    candidateArtifactSha256: WORKFLOW_CANDIDATE.sha256,
    canaryPackageName: STRUCTURAL_CANARY.packageName,
    canaryVersionCode: STRUCTURAL_CANARY.versionCode,
    canaryArtifactSha256: STRUCTURAL_CANARY.sha256,
    directInstallCanaryArtifactSha256: DIRECT_INSTALL_CANARY.sha256,
    structuralFixtureProvider: "SUWAYOMI_EXTENSION_MANAGER",
    contentFixtureProvider: "SUWAYOMI_LOCAL_SOURCE",
    websiteRequests: 0,
    maxSourcesInParallel: 1,
    phases: [],
    passed: false,
  };
  let port = null;
  let fixtureStore = null;
  try {
    await mkdir(runtimeRoot, { recursive: true });
    await createLocalSourceFixture(runtimeRoot);
    const baselineJar = await ensurePinnedFile(options["baseline-jar"] ?? await defaultBaselineJar(), tempRoot, {
      ...WORKFLOW_BASELINE,
      fileName: `Suwayomi-Server-${WORKFLOW_BASELINE.version}.jar`,
    });
    const candidateJar = await ensurePinnedFile(options["candidate-jar"], tempRoot, {
      ...WORKFLOW_CANDIDATE,
      fileName: `Suwayomi-Server-${WORKFLOW_CANDIDATE.version}.jar`,
    });
    const canaryArtifact = await ensurePinnedFile(options["canary-artifact"], tempRoot, STRUCTURAL_CANARY);
    const directInstallArtifact = await ensurePinnedFile(
      options["direct-install-artifact"],
      tempRoot,
      DIRECT_INSTALL_CANARY,
    );
    const converterPort = await allocateLoopbackPort();
    await writeFile(path.join(runtimeRoot, "server.conf"), serverConfig(converterPort, { extensionRepos: [] }));
    const converterEndpoint = `http://127.0.0.1:${converterPort}/api/graphql`;
    const converter = startRuntime(java, baselineJar, runtimeRoot);
    try {
      await waitForHealth(converterEndpoint, converter, timeoutMs);
      await assertPortOwnedByProcess(converterPort, converter.child.pid);
      await installCanary(converterEndpoint, canaryArtifact, false);
      assertNoStructuralRuntimeErrors(converter.output);
      report.phases.push({ name: "official-v21-conversion", passed: true });
    } catch (error) {
      const tail = converter.output.slice(-40).join("\n").replaceAll(tempRoot, "<temp-root>");
      throw new Error(`Baseline conversion phase failed: ${errorChain(error)}\n${tail}`, { cause: error });
    } finally {
      await stopRuntime(converter.child, converterPort);
      await assertNoRuntimeForRoot(runtimeRoot);
    }
    const generatedCanaryJar = await findGeneratedCanaryJar(runtimeRoot);
    report.canaryGeneratedJarSha256 = generatedCanaryJar.sha256;

    fixtureStore = await startFixtureStoreServer(
      directInstallArtifact,
      DIRECT_INSTALL_CANARY,
    );
    const directRoot = path.join(tempRoot, "direct-v23-profile");
    await mkdir(directRoot, { recursive: true });
    const directPort = await allocateLoopbackPort();
    await writeFile(path.join(directRoot, "server.conf"), serverConfig(directPort, {
      extensionStores: [fixtureStore.indexUrl],
    }));
    const directEndpoint = `http://127.0.0.1:${directPort}/api/graphql`;
    let directIdentity = null;
    for (const name of ["exact-v23-jar-install", "exact-v23-jar-restart"]) {
      const runtime = startRuntime(java, candidateJar, directRoot);
      try {
        await waitForHealth(directEndpoint, runtime, timeoutMs);
        await assertPortOwnedByProcess(directPort, runtime.child.pid);
        if (name === "exact-v23-jar-install") {
          await installStoreCanary(
            directEndpoint,
            DIRECT_INSTALL_CANARY,
            fixtureStore.jarUrl,
          );
        } else {
          await refreshStoreExtensions(directEndpoint);
        }
        const identity = await collectInstalledExtensionIdentity(
          directEndpoint,
          DIRECT_INSTALL_CANARY,
        );
        let persistedArtifact = null;
        if (name === "exact-v23-jar-install") {
          persistedArtifact = await waitForPinnedExtensionJar(
            directRoot,
            DIRECT_INSTALL_CANARY.sha256,
          );
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          const stableIdentity = await collectInstalledExtensionIdentity(
            directEndpoint,
            DIRECT_INSTALL_CANARY,
          );
          if (JSON.stringify(identity) !== JSON.stringify(stableIdentity)) {
            throw new Error("Exact V23 extension identity changed before the restart boundary.");
          }
        }
        if (directIdentity && JSON.stringify(directIdentity) !== JSON.stringify(identity)) {
          throw new Error("Exact V23 JAR extension identity changed after restart.");
        }
        directIdentity = identity;
        assertNoStructuralRuntimeErrors(runtime.output);
        report.phases.push({ name, passed: true, identity, persistedArtifact });
      } catch (error) {
        const tail = runtime.output.slice(-40).join("\n").replaceAll(tempRoot, "<temp-root>");
        throw new Error(`${name} phase failed: ${errorChain(error)}\n${tail}`, { cause: error });
      } finally {
        await stopRuntime(runtime.child, directPort);
        await assertNoRuntimeForRoot(directRoot);
      }
    }
    report.fixtureStoreRequests = [...fixtureStore.requests];

    port = await allocateLoopbackPort();
    await writeFile(path.join(runtimeRoot, "server.conf"), serverConfig(port, { extensionStores: [] }));
    const endpoint = `http://127.0.0.1:${port}/api/graphql`;

    let candidateWorkflow = null;
    for (const name of ["candidate", "restart"]) {
      const runtime = startRuntime(java, candidateJar, runtimeRoot);
      try {
        await waitForHealth(endpoint, runtime, timeoutMs);
        await assertPortOwnedByProcess(port, runtime.child.pid);
        const workflow = name === "restart" && candidateWorkflow
          ? await waitForMatchingWorkflow(candidateWorkflow, () => collectWorkflow(endpoint))
          : await collectWorkflow(endpoint);
        if (name === "candidate") candidateWorkflow = workflow;
        assertNoStructuralRuntimeErrors(runtime.output);
        report.phases.push({ name, passed: true, workflow });
      } catch (error) {
        const tail = runtime.output.slice(-40).join("\n").replaceAll(tempRoot, "<temp-root>");
        throw new Error(`${name} phase failed: ${errorChain(error)}\n${tail}`, { cause: error });
      } finally {
        await stopRuntime(runtime.child, port);
        await assertNoRuntimeForRoot(runtimeRoot);
      }
    }
    const candidatePhase = report.phases.find((phase) => phase.name === "candidate");
    const restartPhase = report.phases.find((phase) => phase.name === "restart");
    if (JSON.stringify(candidatePhase?.workflow) !== JSON.stringify(restartPhase?.workflow)) {
      throw new Error("Deterministic workflow identity changed after restart.");
    }
    report.passed = true;
  } catch (error) {
    report.error = errorChain(error);
    throw error;
  } finally {
    try {
      await fixtureStore?.close();
      if (artifactDir) {
        await mkdir(artifactDir, { recursive: true });
        await writeFile(path.join(artifactDir, "extension-workflow-certification.json"), `${JSON.stringify(report, null, 2)}\n`);
      }
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${errorChain(error)}\n`);
    process.exitCode = 1;
  });
}
