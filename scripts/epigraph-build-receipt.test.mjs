import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshot, finish, validateReceipt } from './epigraph-build-receipt.mjs';

test('build receipt binds frozen inputs, exact worktree/profile and executable bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epigraph-receipt-test-'));
  execFileSync('git', ['init', root], { stdio: 'pipe' });
  // Disposable empty repository HEAD, without staging or committing user work.
  execFileSync('git', ['-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/fixture']);
  const tree = execFileSync('git', ['-C', root, 'hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' }).toString().trim();
  const commit = execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit-tree', tree, '-m', 'disposable fixture']).toString().trim();
  execFileSync('git', ['-C', root, 'update-ref', 'refs/heads/fixture', commit]);
  fs.writeFileSync(path.join(root, 'input.txt'), 'source A');
  const output = path.join(os.tmpdir(), `epigraph-receipt-${crypto.randomUUID()}`);
  const state = snapshot(root, output, 'profile-a', 'dev');
  const exe = path.join(output, 'built.exe'); fs.writeFileSync(exe, 'binary A');
  const receipt = finish(output, exe, exe), expected = { project: root, profile: 'profile-a', mode: 'dev' };
  assert.equal(validateReceipt(receipt, expected).buildId, state.buildId);
  assert.throws(() => validateReceipt(receipt, { ...expected, profile: 'profile-b' }));
  assert.throws(() => validateReceipt(receipt, { ...expected, mode: 'main' }));
  assert.throws(() => validateReceipt({ ...receipt, version: 0 }, expected));
  fs.writeFileSync(receipt.executable, 'foreign binary');
  assert.throws(() => validateReceipt(receipt, expected));
  fs.writeFileSync(receipt.executable, 'binary A');
  fs.writeFileSync(receipt.coreExecutable, 'foreign Core');
  assert.throws(() => validateReceipt(receipt, expected));
  fs.writeFileSync(receipt.coreExecutable, 'binary A');
  fs.writeFileSync(path.join(root, 'input.txt'), 'source B');
  assert.throws(() => validateReceipt(receipt, expected));
  fs.writeFileSync(path.join(state.source, 'input.txt'), 'changed snapshot');
  assert.throws(() => finish(output, exe, exe), /Snapshot modified/);
  assert.ok(fs.existsSync(path.join(output, 'inputs.json')));
});

test('identity-checked receipt refuses an executable built for another snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epigraph-receipt-identity-'));
  execFileSync('git', ['init', root], { stdio: 'pipe' });
  execFileSync('git', ['-C', root, 'symbolic-ref', 'HEAD', 'refs/heads/fixture']);
  const tree = execFileSync('git', ['-C', root, 'hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' }).toString().trim();
  const commit = execFileSync('git', ['-C', root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', 'commit-tree', tree, '-m', 'disposable fixture']).toString().trim();
  execFileSync('git', ['-C', root, 'update-ref', 'refs/heads/fixture', commit]);
  fs.writeFileSync(path.join(root, 'input.txt'), 'source A');
  const stale = path.join(os.tmpdir(), `epigraph-receipt-${crypto.randomUUID()}`);
  const previous = snapshot(root, stale, 'profile-a', 'dev');
  const output = path.join(os.tmpdir(), `epigraph-receipt-${crypto.randomUUID()}`);
  const state = snapshot(root, output, 'profile-a', 'dev');
  const core = path.join(output, 'core.bin'); fs.writeFileSync(core, 'core');
  // A cached binary from the previous build carries the previous identity only.
  const reused = path.join(output, 'reused.exe');
  fs.writeFileSync(reused, `prefix ${previous.buildId} ${previous.sourceFingerprint} suffix`);
  assert.throws(() => finish(output, reused, core, { requireIdentity: true }), /does not embed this build identity/);
  assert.ok(!fs.existsSync(path.join(output, 'receipt.json')));
  const fresh = path.join(output, 'fresh.exe');
  fs.writeFileSync(fresh, `prefix ${state.buildId} ${state.sourceFingerprint} suffix`);
  const receipt = finish(output, fresh, core, { requireIdentity: true });
  assert.equal(validateReceipt(receipt, { project: root, profile: 'profile-a', mode: 'dev' }).buildId, state.buildId);
});
