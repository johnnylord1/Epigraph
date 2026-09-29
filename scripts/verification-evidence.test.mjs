import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createVerification, readReceipt, treeFingerprint, sanitize, pruneEvidence, supervise, recordJourneyFailure } from './verification-evidence.mjs';
import { snapshot, finish } from './epigraph-build-receipt.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epigraph-b6-'));
  const project = path.join(root, 'repo'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(project, 'source.txt'), 'initial'); git('add', '.'); git('commit', '-m', 'fixture');
  return { root, project, git, evidenceRoot: process.env.EPIGRAPH_VERIFICATION_ROOT ? path.join(process.env.EPIGRAPH_VERIFICATION_ROOT, path.basename(root)) : path.join(root, 'evidence') };
}
const stages = [{ id: 'prepare', name: 'Fixture preparation', kind: 'preparation', required: true },
  { id: 'gate', name: 'Exact fixture assertion', kind: 'verification', required: true },
  { id: 'conditional', name: 'Optional live backend', kind: 'verification', required: false }];
const start = f => createVerification({ ...f, runner: 'fixture', stages, scope: { journeys: ['fixture assertion only'], environment: 'disposable', backend: { kind: 'mock' } } });

test('RUNNING is persisted before gates; finalized success includes initial/final state', () => {
  const f = fixture(), v = start(f); const running = readReceipt(v.file);
  assert.equal(running.receiptState, 'RUNNING'); assert.notEqual(running.outcome, 'PASS');
  assert.equal(running.stages[0].status, 'NOT_RUN');
  v.stage('prepare', 'PASS'); v.stage('gate', 'PASS'); v.stage('conditional', 'NOT_APPLICABLE', { reason: 'mock fixture' });
  v.finish(); const r = readReceipt(v.file);
  assert.equal(r.receiptState, 'FINALIZED'); assert.equal(r.outcome, 'PASS'); assert.equal(r.tree.initial.digest, r.tree.final.digest);
});
test('failure survives disposable cleanup, later success cannot overwrite it, rerun is distinct', () => {
  const f = fixture(), v = start(f), scratch = path.join(f.root, 'scratch'); fs.mkdirSync(scratch);
  v.stage('prepare', 'PASS'); v.stage('gate', 'FAIL', { reason: 'intentional gate failure' });
  assert.throws(() => v.stage('gate', 'PASS'));
  v.finish({ cleanup: () => fs.rmSync(scratch, { recursive: true }) });
  assert.equal(readReceipt(v.file).outcome, 'FAIL'); assert.ok(readReceipt(v.file).tree.final); assert.ok(!fs.existsSync(scratch));
  const next = start(f); assert.notEqual(next.file, v.file); assert.equal(readReceipt(v.file).outcome, 'FAIL');
  next.finish(); assert.notEqual(readReceipt(next.file).outcome, 'PASS');
});
test('dirty index, unstaged and untracked state are distinct; no contents or paths are serialized', () => {
  const f = fixture(), a = treeFingerprint(f.project);
  fs.writeFileSync(path.join(f.project, 'source.txt'), 'staged-secret'); f.git('add', '.'); const b = treeFingerprint(f.project);
  fs.writeFileSync(path.join(f.project, 'source.txt'), 'unstaged-secret'); const c = treeFingerprint(f.project);
  fs.writeFileSync(path.join(f.project, '.env'), 'TOKEN=never-persist-this'); const d = treeFingerprint(f.project);
  assert.equal(new Set([a.digest, b.digest, c.digest, d.digest]).size, 4);
  assert.equal(d.dirty, true); assert.doesNotMatch(JSON.stringify(d), /never-persist|staged-secret|\.env/);
  const v = start(f); v.stage('prepare', 'PASS'); v.stage('gate', 'PASS'); v.finish(); assert.equal(readReceipt(v.file).outcome, 'PASS');
});
test('stale executable and mismatched build receipt fail through the B1 validator', () => {
  const f = fixture(), output = path.join(f.root, 'candidate'); snapshot(f.project, output, 'test', 'dev');
  const exe = path.join(f.root, 'app.bin'), core = path.join(f.root, 'core.bin'); fs.writeFileSync(exe, 'desktop'); fs.writeFileSync(core, 'core');
  const receipt = finish(output, exe, core); const receiptPath = path.join(output, 'receipt.json');
  const good = start(f); good.bindBuild({ receiptPath, profile: 'test', mode: 'dev' }); assert.equal(readReceipt(good.file).build.validation, 'PASS'); good.finish();
  const mismatch = start(f); assert.throws(() => mismatch.bindBuild({ receiptPath, profile: 'foreign', mode: 'dev' })); mismatch.finish(); assert.equal(readReceipt(mismatch.file).outcome, 'FAIL');
  fs.writeFileSync(receipt.executable, 'stale binary'); const stale = start(f);
  assert.throws(() => stale.bindBuild({ receiptPath, profile: 'test', mode: 'dev' })); stale.finish(); assert.equal(readReceipt(stale.file).outcome, 'FAIL');
});
test('cleanup failure and skipped required stage remain truthful', () => {
  const f = fixture(), v = start(f); v.stage('prepare', 'PASS'); v.stage('gate', 'SKIPPED', { reason: 'backend unavailable' });
  v.finish({ cleanup: () => { throw new Error('intentional cleanup failure'); } }); const r = readReceipt(v.file);
  assert.equal(r.cleanup.status, 'FAIL'); assert.equal(r.stages[1].status, 'SKIPPED'); assert.equal(r.outcome, 'FAIL');
  const skipped = start(f); skipped.stage('prepare', 'PASS'); skipped.stage('gate', 'SKIPPED', { reason: 'no backend' }); skipped.finish(); assert.equal(readReceipt(skipped.file).outcome, 'NOT_TESTED');
});
test('secrets and sensitive URL fields cannot leak into receipt diagnostics', () => {
  const f = fixture(), v = start(f);
  const input = 'Bearer abc-token\npassword="multi word secret"\nCookie: session=private\nhttps://user:pass@example.invalid/x?token=secret#cookie\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----';
  v.diagnostic('failure', input); v.stage('gate', 'FAIL', { reason: input }); v.finish();
  const persisted = fs.readdirSync(path.dirname(v.file)).map(n => fs.readFileSync(path.join(path.dirname(v.file), n), 'utf8')).join('');
  assert.doesNotMatch(persisted, /abc-token|multi word secret|session=private|user:pass|token=secret|private-material/);
  assert.doesNotMatch(JSON.stringify(sanitize({ access_token: 'hidden', nested: { cookie: 'hidden' } })), /hidden/);
});
test('interruption is terminal and cannot become completed PASS', () => {
  const f = fixture(), v = start(f); v.beginStage('gate'); v.finish({ interrupted: true });
  const r = readReceipt(v.file); assert.equal(r.receiptState, 'INTERRUPTED'); assert.notEqual(r.outcome, 'PASS'); assert.ok(r.tree.final);
  assert.throws(() => v.stage('gate', 'PASS')); assert.throws(() => v.finish());
});
test('supervisor records a deliberately killed worker as interrupted with final tree', async () => {
  const f = fixture(); const v = start(f); v.beginStage('gate');
  const result = await supervise(v, process.execPath, ['-e', 'setInterval(()=>{},1000)'], { onSpawn: child => setTimeout(() => child.kill(), 100) });
  assert.equal(result.receiptState, 'INTERRUPTED'); assert.ok(result.tree.final); assert.notEqual(result.outcome, 'PASS');
});
test('local retention never removes active runs; oversized diagnostics are bounded', () => {
  const f = fixture(), running = start(f), old = start(f); old.stage('gate', 'FAIL'); old.finish();
  pruneEvidence(f.evidenceRoot, { maxRuns: 0, maxAgeDays: 0, maxBytes: 0 });
  assert.ok(fs.existsSync(running.file)); assert.ok(!fs.existsSync(old.file));
  running.diagnostic('large', 'x'.repeat(12 * 1024 * 1024)); running.finish();
  assert.ok(fs.readdirSync(path.dirname(running.file)).reduce((n, p) => n + fs.statSync(path.join(path.dirname(running.file), p)).size, 0) <= 10 * 1024 * 1024);
  assert.equal(readReceipt(running.file).diagnostics[0].truncated, true);
});
test('quoted JSON, nested API keys and auth variants are redacted', () => {
  for (const input of [JSON.stringify({ token: 'fixture-token', password: 'fixture-password', api_key: 'fixture-api-key' }),
    JSON.stringify({ cookie: 'fixture-cookie', authorization: 'fixture-auth', privateKey: 'fixture-key' }),
    { api_key: 'fixture-api-key', apiKey: 'fixture-api-key', nested: { password: 'fixture-password' } },
    'Authorization: Basic fixture-basic\n"access_token": "fixture-token"']) {
    assert.doesNotMatch(JSON.stringify(sanitize(input)), /fixture-token|fixture-password|fixture-api-key|fixture-basic|fixture-cookie|fixture-auth|fixture-key/);
  }
});
test('assertion failure is durable before cleanup begins', () => {
  const f = fixture(); const v = createVerification({ ...f, runner: 'journey-fixture', stages: [{ id: 'journey', kind: 'verification' }] });
  v.beginStage('journey'); recordJourneyFailure(v, new Error('assertion failed before cleanup'));
  const beforeCleanup = readReceipt(v.file); assert.equal(beforeCleanup.stages[0].status, 'FAIL');
  assert.match(beforeCleanup.failures[0].reason, /assertion failed/);
  v.finish({ cleanup: () => { assert.equal(readReceipt(v.file).stages[0].status, 'FAIL'); throw new Error('cleanup also failed'); } });
  assert.equal(readReceipt(v.file).failures.length, 2);
});

test('changed tree fails even after a successful gate; ignored secrets are excluded', () => {
  const f = fixture(); fs.writeFileSync(path.join(f.project, '.gitignore'), '.env.local\n'); f.git('add', '.'); f.git('commit', '-m', 'ignore fixture');
  const initial = treeFingerprint(f.project); fs.writeFileSync(path.join(f.project, '.env.local'), 'arbitrary secret contents');
  assert.equal(initial.digest, treeFingerprint(f.project).digest);
  const v = start(f); v.stage('gate', 'PASS'); fs.writeFileSync(path.join(f.project, 'source.txt'), 'changed during gate'); v.finish();
  assert.equal(readReceipt(v.file).tree.comparison, 'FAIL'); assert.equal(readReceipt(v.file).outcome, 'FAIL');
});
test('nonfinal PASS receipt is rejected by the reader', () => {
  const f = fixture(), v = start(f); const tampered = readReceipt(v.file); tampered.outcome = 'PASS';
  fs.writeFileSync(v.file, JSON.stringify(tampered)); assert.throws(() => readReceipt(v.file), /Nonfinal/);
});
