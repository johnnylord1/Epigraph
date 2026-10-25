// Publishes desktop and mobile releases independently and keeps the `stable`
// release up to date. See docs/releasing.md.
//
//   node scripts/publish-release.mjs status
//   node scripts/publish-release.mjs desktop <version> [--notes <file>]
//   node scripts/publish-release.mjs mobile <version> <apk-dir> --notes <file>
//   node scripts/publish-release.mjs init <existing-tag>
//
// Every command accepts --dry-run, which prints the plan without changing GitHub.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = "johnnylord1/Epigraph";
const STABLE = "stable";
const STABLE_TITLE = "Epigraph — current versions";
const MOBILE_ABIS = ["arm64-v8a", "armeabi-v7a", "universal"];
const MOBILE_APK = /^Epigraph-mobile_(.+)_[^_]+\.apk$/;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const positional = [];
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--notes") options.notes = args[++i];
  else if (!args[i].startsWith("--")) positional.push(args[i]);
}
const [command, ...rest] = positional;

function gh(ghArgs, { mutating = false } = {}) {
  if (mutating && dryRun) {
    console.log(`[dry-run] gh ${ghArgs.join(" ")}`);
    return "";
  }
  return execFileSync("gh", [...ghArgs, "--repo", REPO], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function viewRelease(tag) {
  try {
    const out = execFileSync(
      "gh",
      ["release", "view", tag, "--repo", REPO, "--json", "tagName,name,body,isDraft,url,assets"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "epigraph-release-"));
}

// Orders 1.2.3 and 1.2.3-alpha.4 style versions; a pre-release sorts before its release.
function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = v.split("-", 2);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const [p, q] = [x.pre[i], y.pre[i]];
    const d = /^\d+$/.test(p) && /^\d+$/.test(q) ? Number(p) - Number(q) : p.localeCompare(q);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Returns the text under `## <heading>` up to the next `## ` heading, or null.
function section(body, heading) {
  const lines = (body ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\b`, "i").test(line));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

function readNotes(file) {
  if (!file) return null;
  const text = fs.readFileSync(file, "utf8").trim();
  if (/^## /m.test(text)) {
    fail(`${file} uses "## " headings; use "###" so the in-app changelog keeps the whole section`);
  }
  return text;
}

function stableState() {
  const stable = viewRelease(STABLE);
  if (!stable) return null;
  let desktop = null;
  if (stable.assets.some((a) => a.name === "latest.json")) {
    const dir = tempDir();
    gh(["release", "download", STABLE, "--pattern", "latest.json", "--dir", dir, "--clobber"]);
    desktop = JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8")).version ?? null;
  }
  const mobile = stable.assets.map((a) => MOBILE_APK.exec(a.name)?.[1]).find(Boolean) ?? null;
  return { release: stable, desktop, mobile };
}

function stableBody({ desktop, mobile, windowsNotes, androidNotes }) {
  const link = (label, tag) => `[${label}](https://github.com/${REPO}/releases/tag/${tag})`;
  return [
    `Desktop **${desktop ?? "—"}** · Mobile **${mobile ?? "—"}**`,
    "",
    "This release always holds the current version of each app, and the in-app updaters read it.",
    [
      desktop && link(`Desktop ${desktop} notes`, `desktop-v${desktop}`),
      mobile && link(`Mobile ${mobile} notes`, `mobile-v${mobile}`),
      `[all releases](https://github.com/${REPO}/releases)`,
    ]
      .filter(Boolean)
      .join(" · "),
    "",
    "## Windows",
    "",
    windowsNotes || "No changes.",
    "",
    // The Android app shows this section as its changelog, so it stays last.
    "## Android",
    "",
    androidNotes || "No changes.",
    "",
  ].join("\n");
}

function writeStableBody(state) {
  const dir = tempDir();
  const file = path.join(dir, "stable.md");
  fs.writeFileSync(file, stableBody(state));
  if (dryRun) console.log(`--- stable notes ---\n${stableBody(state)}--------------------`);
  return file;
}

function guardVersion(kind, current, next) {
  if (current && compareVersions(next, current) < 0 && !force) {
    fail(`${kind} ${next} is older than the current ${current}; pass --force to roll back`);
  }
}

function publishDesktop(version) {
  if (!version) fail("usage: desktop <version> [--notes <file>]");
  const tag = `desktop-v${version}`;
  const release = viewRelease(tag);
  if (!release) fail(`${tag} does not exist; run the "Build Windows" workflow first`);
  const names = release.assets.map((a) => a.name);
  for (const required of [`Epigraph_${version}_x64-setup.exe`, `Epigraph_${version}_x64-setup.exe.sig`, "latest.json"]) {
    if (!names.includes(required)) fail(`${tag} is missing ${required}`);
  }

  const dir = tempDir();
  gh(["release", "download", tag, "--pattern", "latest.json", "--dir", dir, "--clobber"]);
  const latestJson = path.join(dir, "latest.json");
  const manifest = JSON.parse(fs.readFileSync(latestJson, "utf8"));
  if (manifest.version !== version) fail(`${tag}/latest.json is for ${manifest.version}`);

  const state = stableState();
  if (!state) fail(`the ${STABLE} release does not exist; run init first`);
  guardVersion("desktop", state.desktop, version);

  const notes = readNotes(options.notes) ?? section(release.body, "Windows") ?? release.body.trim();
  if (options.notes) {
    const bodyFile = path.join(dir, "desktop.md");
    fs.writeFileSync(bodyFile, `## Windows\n\n${notes}\n`);
    gh(["release", "edit", tag, "--notes-file", bodyFile], { mutating: true });
  }
  gh(["release", "edit", tag, "--draft=false", "--prerelease", "--latest=false", "--title", `Epigraph Desktop ${version}`], { mutating: true });
  gh(["release", "upload", STABLE, latestJson, "--clobber"], { mutating: true });
  const bodyFile = writeStableBody({
    desktop: version,
    mobile: state.mobile,
    windowsNotes: notes,
    androidNotes: section(state.release.body, "Android"),
  });
  gh(["release", "edit", STABLE, "--notes-file", bodyFile, "--latest"], { mutating: true });
  console.log(`Desktop ${version} published; ${STABLE} now serves it to the updater.`);
}

function publishMobile(version, apkDir) {
  if (!version || !apkDir) fail("usage: mobile <version> <apk-dir> --notes <file>");
  const notes = readNotes(options.notes);
  if (!notes) fail("mobile releases need --notes <file>");
  // Only the store builds for these ABIs are published; test or emulator APKs never match.
  const apks = MOBILE_ABIS.map((abi) => path.join(apkDir, `Epigraph-mobile_${version}_${abi}.apk`));
  for (const apk of apks) if (!fs.existsSync(apk)) fail(`missing ${apk}`);

  const tag = `mobile-v${version}`;
  if (viewRelease(tag)) fail(`${tag} already exists`);
  const state = stableState();
  if (!state) fail(`the ${STABLE} release does not exist; run init first`);
  guardVersion("mobile", state.mobile, version);

  const dir = tempDir();
  const bodyFile = path.join(dir, "mobile.md");
  fs.writeFileSync(bodyFile, `## Android\n\n${notes}\n`);
  gh(
    ["release", "create", tag, ...apks, "--title", `Epigraph Mobile ${version}`, "--notes-file", bodyFile, "--prerelease", "--latest=false", "--target", "main"],
    { mutating: true },
  );
  // Upload first so `stable` never goes without an APK, then drop the previous version's.
  gh(["release", "upload", STABLE, ...apks, "--clobber"], { mutating: true });
  const current = apks.map((apk) => path.basename(apk));
  for (const asset of state.release.assets) {
    if (MOBILE_APK.test(asset.name) && !current.includes(asset.name)) {
      gh(["release", "delete-asset", STABLE, asset.name, "--yes"], { mutating: true });
    }
  }
  const stableFile = writeStableBody({
    desktop: state.desktop,
    mobile: version,
    windowsNotes: section(state.release.body, "Windows"),
    androidNotes: notes,
  });
  gh(["release", "edit", STABLE, "--notes-file", stableFile, "--latest"], { mutating: true });
  console.log(`Mobile ${version} published; ${STABLE} now serves it to the updater.`);
}

// Creates `stable` from a release that already has latest.json and the mobile APKs.
function init(fromTag) {
  if (!fromTag) fail("usage: init <existing-tag>");
  if (viewRelease(STABLE)) fail(`${STABLE} already exists`);
  const source = viewRelease(fromTag);
  if (!source) fail(`${fromTag} does not exist`);

  const dir = tempDir();
  const wanted = source.assets.map((a) => a.name).filter((name) => name === "latest.json" || MOBILE_ABIS.some((abi) => name.endsWith(`_${abi}.apk`) && MOBILE_APK.test(name)));
  for (const name of wanted) gh(["release", "download", fromTag, "--pattern", name, "--dir", dir, "--clobber"]);
  const desktop = wanted.includes("latest.json")
    ? JSON.parse(fs.readFileSync(path.join(dir, "latest.json"), "utf8")).version
    : null;
  const mobile = wanted.map((name) => MOBILE_APK.exec(name)?.[1]).find(Boolean) ?? null;

  const bodyFile = writeStableBody({
    desktop,
    mobile,
    windowsNotes: section(source.body, "Windows"),
    androidNotes: section(source.body, "Android"),
  });
  gh(
    ["release", "create", STABLE, ...wanted.map((name) => path.join(dir, name)), "--title", STABLE_TITLE, "--notes-file", bodyFile, "--latest", "--target", "main"],
    { mutating: true },
  );
  console.log(`${STABLE} created with desktop ${desktop ?? "none"} and mobile ${mobile ?? "none"}.`);
}

function status() {
  const state = stableState();
  if (!state) {
    console.log(`${STABLE}: not created yet`);
    return;
  }
  console.log(`${STABLE}: desktop ${state.desktop ?? "none"}, mobile ${state.mobile ?? "none"}`);
  console.log(state.release.url);
}

switch (command) {
  case "desktop":
    publishDesktop(rest[0]);
    break;
  case "mobile":
    publishMobile(rest[0], rest[1]);
    break;
  case "init":
    init(rest[0]);
    break;
  case "status":
    status();
    break;
  default:
    fail("usage: publish-release.mjs <status|desktop|mobile|init> ... [--dry-run]");
}
