import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateReceipt } from './epigraph-build-receipt.mjs';

export const LOCAL_RETENTION = Object.freeze({ maxAgeDays: 30, maxRuns: 100, maxBytes: 1024 ** 3, perRunBytes: 10 * 1024 ** 2 });
const STATES = new Set(['PASS', 'FAIL', 'SKIPPED', 'NOT_APPLICABLE', 'NOT_RUN']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const git = (root, ...args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const sensitiveKey = /password|passwd|secret|token|cookie|credential|authorization|private.?key|api[_-]?key/i;
export function sanitize(value, depth = 0) {
  if (depth > 12) return '[depth limited]';
  if (Array.isArray(value)) return value.slice(0, 200).map(v => sanitize(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 200).map(([k, v]) => [k, sensitiveKey.test(k) ? '[redacted]' : sanitize(v, depth + 1)]));
  if (typeof value !== 'string') return value;
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[private key redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => { try { const u = new URL(raw); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); } catch { return '[URL redacted]'; } })
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:cookie|set-cookie|authorization)\s*:[^\r\n]*/gi, '[sensitive header redacted]')
    .replace(/["']?\b(?:[\w.-]*(?:password|passwd|secret|token|credential|api[_-]?key|cookie|authorization|private.?key)[\w.-]*)["']?\s*[=:]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '[sensitive assignment redacted]')
    .replaceAll(os.homedir(), '<home>').replaceAll(os.homedir().replaceAll('\\', '/'), '<home>')
    .slice(0, 8192);
}
export function treeFingerprint(project) {
  project = fs.realpathSync(project);
  const head = git(project, 'rev-parse', 'HEAD').toString().trim();
  const index = git(project, 'ls-files', '--stage', '-z');
  const status = git(project, 'status', '--porcelain=v1', '-z', '--untracked-files=all');
  const files = [...new Set(git(project, 'ls-files', '-co', '--exclude-standard', '-z').toString().split('\0').filter(Boolean))].sort();
  const entries = files.map(file => {
    const target = path.join(project, file), pathDigest = hash(file);
    if (!fs.existsSync(target)) return { pathDigest, state: 'deleted' };
    const before = fs.lstatSync(target);
    // Never follow links or enumerate ignored folders. Only digests leave memory.
    if (before.isSymbolicLink()) return { pathDigest, kind: 'symlink', digest: hash(fs.readlinkSync(target)) };
    if (before.isDirectory()) return { pathDigest, kind: 'gitlink-or-directory' };
    if (!before.isFile()) throw new Error('Unsupported verification input type');
    const digest = hash(fs.readFileSync(target)), after = fs.lstatSync(target);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Input changed during tree capture');
    return { pathDigest, kind: 'file', digest, size: after.size };
  });
  if (!index.equals(git(project, 'ls-files', '--stage', '-z')) || !status.equals(git(project, 'status', '--porcelain=v1', '-z', '--untracked-files=all')) || head !== git(project, 'rev-parse', 'HEAD').toString().trim()) throw new Error('Repository changed during tree capture');
  const state = { head, indexDigest: hash(index), statusDigest: hash(status), filesDigest: hash(JSON.stringify(entries)), fileCount: entries.length, dirty: status.length > 0 };
  return { version: 1, capturedAt: now(), status: 'PASS', ...state, digest: hash(JSON.stringify(state)), policy: 'git-index-and-nonignored-worktree-v1' };
}
function atomic(file, value) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > 512 * 1024) throw new Error('Receipt size limit exceeded');
  const pending = `${file}.${crypto.randomUUID()}.pending`;
  const fd = fs.openSync(pending, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(pending, file);
}
export function readReceipt(file) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (r.schemaVersion !== 1 || !['RUNNING', 'FINALIZED', 'INTERRUPTED'].includes(r.receiptState)) throw new Error('Invalid verification receipt');
  if (r.outcome === 'PASS' && r.receiptState !== 'FINALIZED') throw new Error('Nonfinal receipt cannot assert PASS');
  return r;
}
export function defaultEvidenceRoot() { return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'Epigraph', 'verification'); }
const directoryBytes = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, item) => n + (item.isFile() ? fs.statSync(path.join(dir, item.name)).size : 0), 0);
export function pruneEvidence(root, policy = {}) {
  const limits = { ...LOCAL_RETENTION, ...policy }; if (!fs.existsSync(root)) return;
  const completed = []; let total = 0;
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    if (!item.isDirectory() || !/^[0-9a-f-]{36}$/.test(item.name)) continue;
    const dir = path.join(root, item.name); if (fs.lstatSync(dir).isSymbolicLink()) continue;
    try { const r = readReceipt(path.join(dir, 'receipt.json')); if (r.verificationId !== item.name) continue;
      const bytes = directoryBytes(dir); total += bytes;
      if (r.receiptState !== 'RUNNING') completed.push({ dir, bytes, time: Date.parse(r.completedAt) });
    } catch { /* Unverifiable or incomplete evidence is preserved. */ }
  }
  completed.sort((a, b) => a.time - b.time); let count = completed.length;
  for (const item of completed) {
    if (count <= limits.maxRuns && total <= limits.maxBytes && Date.now() - item.time <= limits.maxAgeDays * 86400000) continue;
    const resolved = fs.realpathSync(item.dir), base = fs.realpathSync(root) + path.sep;
    if (!resolved.startsWith(base)) throw new Error('Retention target escaped evidence root');
    fs.rmSync(resolved, { recursive: true }); total -= item.bytes; count--;
  }
  return { bytes: total, completedRuns: count };
}
export function createVerification({ project = process.cwd(), evidenceRoot = process.env.EPIGRAPH_VERIFICATION_ROOT || defaultEvidenceRoot(), runner, stages = [], scope = {} }) {
  project = fs.realpathSync(project); evidenceRoot = path.resolve(evidenceRoot);
  if (evidenceRoot === project || evidenceRoot.startsWith(project + path.sep)) throw new Error('Durable evidence must be outside the source tree');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const capacity = pruneEvidence(evidenceRoot, { maxBytes: LOCAL_RETENTION.maxBytes - LOCAL_RETENTION.perRunBytes });
  if (capacity.bytes > LOCAL_RETENTION.maxBytes - LOCAL_RETENTION.perRunBytes) throw new Error('Local evidence capacity exhausted by protected runs; no gates started');
  const verificationId = crypto.randomUUID(), dir = path.join(evidenceRoot, verificationId); fs.mkdirSync(dir);
  const file = path.join(dir, 'receipt.json');
  if (stages.length > 100 || new Set(stages.map(s => s.id)).size !== stages.length) throw new Error('Invalid stage declarations');
  const r = { schemaVersion: 1, verificationId, receiptState: 'RUNNING', outcome: 'NOT_TESTED', startedAt: now(), completedAt: null,
    runner: { name: runner, sha256: fs.existsSync(path.join(project, 'scripts', path.basename(runner))) ? hash(fs.readFileSync(path.join(project, 'scripts', path.basename(runner)))) : null,
      platform: process.platform, node: process.version, parentVerificationId: process.env.EPIGRAPH_VERIFICATION_ID || null },
    repository: { worktree: sanitize(project), worktreeDigest: hash(project) }, tree: { initial: null, final: null, comparison: 'NOT_RUN' },
    build: { validation: 'NOT_RUN', reason: 'No B1 build receipt bound' }, artifacts: {}, scope: sanitize(scope),
    backend: sanitize({ availability: 'NOT_TESTED', version: null, capabilities: null, ...(scope.backend || { kind: 'unavailable', reason: 'Not observed by this harness' }) }),
    stages: stages.map(s => ({ ...sanitize(s), required: s.required !== false, status: 'NOT_RUN', startedAt: null, completedAt: null })),
    cleanup: { status: 'NOT_RUN' }, diagnostics: [], limitations: [], failures: [], retention: { local: LOCAL_RETENTION,
      ciRequestedDays: process.env.GITHUB_ACTIONS ? Number(process.env.EPIGRAPH_CI_RETENTION_DAYS || 30) : null,
      ciConfiguredDays: process.env.GITHUB_RETENTION_DAYS ? Number(process.env.GITHUB_RETENTION_DAYS) : null } };
  atomic(file, r); const v = new Verification(file, project, r);
  try { r.tree.initial = treeFingerprint(project); r.repository.head = r.tree.initial.head; r.repository.dirty = r.tree.initial.dirty; }
  catch (e) { r.tree.initial = { status: 'FAIL', reason: sanitize(e.message) }; r.failures.push({ location: 'initial-tree', reason: sanitize(e.message) }); }
  v.save(); return v;
}
class Verification {
  constructor(file, project, receipt) { this.file = file; this.project = project; this.r = receipt; }
  save() { atomic(this.file, this.r); }
  mutable() { if (this.r.receiptState !== 'RUNNING') throw new Error('Terminal evidence is immutable'); }
  beginStage(id) { this.mutable(); const s = this.r.stages.find(s => s.id === id); if (!s || s.status !== 'NOT_RUN' || s.startedAt) throw new Error('Stage cannot restart'); s.startedAt = now(); this.save(); }
  stage(id, status, detail = {}) {
    this.mutable(); if (!STATES.has(status)) throw new Error('Invalid stage status');
    const s = this.r.stages.find(s => s.id === id); if (!s || s.status !== 'NOT_RUN') throw new Error('Stage result is immutable');
    if (['SKIPPED', 'NOT_APPLICABLE'].includes(status) && !detail.reason) throw new Error('Conditional stage requires reason');
    Object.assign(s, sanitize(detail), { id: s.id, name: s.name, kind: s.kind, required: s.required, status, completedAt: now() });
    if (status === 'FAIL') this.r.failures.push({ location: id, reason: sanitize(detail.reason || 'Stage failed') });
    this.save();
  }
  bindBuild({ receiptPath, profile, mode }) {
    this.mutable();
    try {
      const bytes = fs.readFileSync(receiptPath), receipt = validateReceipt(JSON.parse(bytes.toString().replace(/^\uFEFF/, '')), { project: this.project, profile, mode });
      this.r.build = { validation: 'PASS', receipt: sanitize(path.resolve(receiptPath)), receiptSha256: hash(bytes), buildId: receipt.buildId, sourceFingerprint: receipt.sourceFingerprint, head: receipt.head };
      this.r.artifacts = { desktop: { path: sanitize(receipt.executable), sha256: receipt.executableSha256 }, core: { path: sanitize(receipt.coreExecutable), sha256: receipt.coreSha256 } };
      this.save();
    } catch { this.r.build = { validation: 'FAIL', reason: 'B1 build receipt validation failed' }; this.r.failures.push({ location: 'artifact-validation', reason: 'Missing, stale or mismatched B1 build receipt' }); this.save(); throw new Error('B1 build receipt validation failed'); }
  }
  diagnostic(label, input) {
    this.mutable(); const dir = path.dirname(this.file), available = Math.max(0, LOCAL_RETENTION.perRunBytes - 512 * 1024 - directoryBytes(dir));
    const limit = Math.min(256 * 1024, available); const raw = typeof input === 'string' ? input : JSON.stringify(input);
    const safe = Buffer.from(typeof input === 'string' ? sanitize(input) : JSON.stringify(sanitize(input)));
    const bytes = safe.subarray(0, limit), name = `diagnostic-${crypto.randomUUID()}.txt`;
    fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx', mode: 0o600 });
    this.r.diagnostics.push({ label: sanitize(label), reference: name, sha256: hash(bytes), bytes: bytes.length, truncated: bytes.length < Buffer.byteLength(raw) }); this.save();
  }
  finish({ cleanup, interrupted = false } = {}) {
    this.mutable();
    // Preserve pre-cleanup failure state before any disposable artifact removal.
    this.save();
    if (cleanup) { try { cleanup(); this.r.cleanup = { status: 'PASS' }; } catch (e) { this.r.cleanup = { status: 'FAIL', reason: sanitize(e.message) }; this.r.failures.push({ location: 'cleanup', reason: sanitize(e.message) }); } }
    else if (this.r.cleanup.status === 'NOT_RUN') this.r.cleanup = { status: 'NOT_APPLICABLE', reason: 'No disposable cleanup supplied to this layer' };
    try { this.r.tree.final = treeFingerprint(this.project); this.r.tree.comparison = this.r.tree.initial?.digest === this.r.tree.final.digest ? 'PASS' : 'FAIL'; }
    catch (e) { this.r.tree.final = { status: 'FAIL', reason: sanitize(e.message) }; this.r.tree.comparison = 'FAIL'; }
    if (this.r.tree.comparison === 'FAIL') this.r.failures.push({ location: 'final-tree', reason: 'Tree changed or comparison unavailable' });
    for (const s of this.r.stages) if (s.status === 'NOT_RUN') s.reason ||= interrupted ? 'Runner interrupted' : 'Not reached or not selected';
    this.r.children = [];
    const root = path.dirname(path.dirname(this.file));
    for (const item of fs.readdirSync(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[0-9a-f-]{36}$/.test(item.name)) continue;
      const file = path.join(root, item.name, 'receipt.json');
      try { const child = readReceipt(file); if (child.runner.parentVerificationId !== this.r.verificationId) continue;
        this.r.children.push({ verificationId: child.verificationId, reference: `${item.name}/receipt.json`, sha256: hash(fs.readFileSync(file)), receiptState: child.receiptState, outcome: child.outcome });
      } catch { /* Unrelated/unreadable folders cannot confer passing evidence. */ }
    }
    if (this.r.children.some(c => c.outcome === 'FAIL')) this.r.failures.push({ location: 'child-verification', reason: 'A child verification failed' });
    const verified = this.r.stages.some(s => s.kind === 'verification' && s.status === 'PASS');
    const missing = this.r.stages.some(s => s.required && ['NOT_RUN', 'SKIPPED'].includes(s.status)) || this.r.children.some(c => c.receiptState !== 'FINALIZED' || c.outcome !== 'PASS');
    this.r.receiptState = interrupted ? 'INTERRUPTED' : 'FINALIZED'; this.r.completedAt = now();
    this.r.outcome = this.r.failures.length ? 'FAIL' : interrupted || missing ? (verified ? 'PARTIAL' : 'NOT_TESTED') : verified ? 'PASS' : 'NOT_TESTED';
    this.save(); pruneEvidence(root); return this.r;
  }
}
export function loadVerification(file, project = process.cwd()) { const r = readReceipt(file); if (hash(fs.realpathSync(project)) !== r.repository.worktreeDigest) throw new Error('Foreign evidence worktree'); return new Verification(file, project, r); }
export async function supervise(v, command, args, { onSpawn } = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: v.project, windowsHide: true, stdio: 'inherit', env: { ...process.env, EPIGRAPH_VERIFICATION_ROOT: path.dirname(path.dirname(v.file)), EPIGRAPH_VERIFICATION_RECEIPT: v.file, EPIGRAPH_VERIFICATION_ID: v.r.verificationId } });
    child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); onSpawn?.(child);
  }).catch(e => ({ code: -1, reason: sanitize(e.message) }));
  v = loadVerification(v.file, v.project);
  if (v.r.receiptState !== 'RUNNING') return v.r;
  if (result.code !== 0 || result.signal) v.r.failures.push({ location: 'worker-exit', reason: 'Worker exited before finalizing', exitCode: result.code });
  return v.finish({ interrupted: true });
}
export function recordJourneyFailure(v, error) {
  if (v.r.stages.find(s => s.id === 'journey')?.status === 'NOT_RUN') v.stage('journey', 'FAIL', { reason: sanitize(error.message || String(error)) });
  v.diagnostic('failure before cleanup', error.message || String(error));
}
export async function cleanupAttempt(v, name, action) {
  try { await action(); v.r.cleanup.attempts ||= []; v.r.cleanup.attempts.push({ name, status: 'PASS' }); if (v.r.cleanup.status !== 'FAIL') v.r.cleanup.status = 'PASS'; }
  catch (e) { v.r.cleanup.status = 'FAIL'; v.r.cleanup.attempts ||= []; v.r.cleanup.attempts.push({ name, status: 'FAIL', reason: sanitize(e.message) }); v.r.failures.push({ location: `cleanup:${name}`, reason: sanitize(e.message) }); }
  v.save();
}
export async function verifyJourney(name, journeys, main, { backend = 'mock', stages, artifactRequired = true } = {}) {
  const v = createVerification({ runner: name, stages: stages || [{ id: 'journey', name, kind: 'verification' }], scope: { journeys, environment: 'disposable', backend: { kind: backend } } });
  try {
    if (artifactRequired && process.env.EPIGRAPH_BUILD_RECEIPT) {
      const b = JSON.parse(fs.readFileSync(process.env.EPIGRAPH_BUILD_RECEIPT, 'utf8').replace(/^\uFEFF/, ''));
      v.bindBuild({ receiptPath: process.env.EPIGRAPH_BUILD_RECEIPT, profile: b.profile, mode: b.mode });
      const requested = process.argv.find(a => a.startsWith('--app='))?.slice(6);
      if (!requested || path.resolve(requested) !== path.resolve(b.executable)) throw new Error('Native requested executable differs from B1 receipt');
    } else if (artifactRequired) throw new Error('Native verification requires EPIGRAPH_BUILD_RECEIPT');
    v.beginStage('journey'); await main(v); v.r.backend.availability = 'AVAILABLE'; v.stage('journey', 'PASS');
  } catch (e) { if (v.r.stages.find(s => s.id === 'journey')?.status === 'NOT_RUN') v.stage('journey', 'FAIL', { reason: sanitize(e.message) }); v.diagnostic('failure', e.message); throw e; }
  finally { const result = v.finish(); console.log(`Verification receipt: ${v.file}`); if (result.outcome === 'FAIL') process.exitCode = 1; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, file] = process.argv.slice(2); const input = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '').trim(); const data = input ? JSON.parse(input) : {};
  if (action === 'create') console.log(createVerification(data).file);
  else {
    const v = loadVerification(file, data.project || process.cwd());
    if (action === 'begin') v.beginStage(data.id);
    else if (action === 'stage') v.stage(data.id, data.status, data.detail);
    else if (action === 'bind') v.bindBuild(data);
    else if (action === 'diagnostic') v.diagnostic(data.label, data.value);
    else if (action === 'cleanup') { v.mutable(); v.r.cleanup = sanitize(data.result); if (data.result.status === 'FAIL') v.r.failures.push({ location: 'cleanup', reason: 'Cleanup failed' }); v.save(); }
    else if (action === 'finish') console.log(JSON.stringify(v.finish(data)));
    else if (action === 'supervise') { const r = await supervise(v, data.command, data.args); console.log(JSON.stringify(r)); if (r.outcome !== 'PASS') process.exitCode = 1; }
    else throw new Error('Unknown evidence operation');
  }
}
