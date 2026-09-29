import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const git = (root, ...args) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });
export function sourceManifest(root) {
  const files = [...new Set(git(root, 'ls-files', '-co', '--exclude-standard', '-z').toString('utf8').split('\0').filter(Boolean))]
    .filter(file => !file.startsWith('docs/') && !file.startsWith('.github/')
      && !/^scripts\/(?:test-|certify-b1-)/.test(file) && !/^scripts\/.*\.test\./.test(file)).sort();
  return files.map(file => {
    const target = path.join(root, file);
    if (!fs.existsSync(target)) return { file, deleted: true };
    if (!fs.lstatSync(target).isFile()) throw new Error(`Non-regular source input refused: ${file}`);
    return { file, sha256: digest(fs.readFileSync(target)) };
  });
}
export const sourceFingerprint = root => digest(JSON.stringify(sourceManifest(root)));
export function validateReceipt(receipt, expected) {
  if (receipt.version !== 1 || receipt.project !== fs.realpathSync(expected.project) || receipt.profile !== expected.profile
    || receipt.mode !== expected.mode || receipt.head !== git(expected.project, 'rev-parse', 'HEAD').toString().trim()
    || receipt.sourceFingerprint !== sourceFingerprint(expected.project)
    || !/^[0-9a-f]{64}$/.test(receipt.executableSha256 ?? '')
    || !/^[0-9a-f-]{36}$/.test(receipt.buildId ?? '') || !path.isAbsolute(receipt.executable)
    || digest(fs.readFileSync(receipt.executable)) !== receipt.executableSha256) {
    throw new Error('Missing, stale, foreign or altered build receipt; rebuild candidate');
  }
  if (!path.isAbsolute(receipt.coreExecutable ?? '') || !/^[0-9a-f]{64}$/.test(receipt.coreSha256 ?? '')
    || digest(fs.readFileSync(receipt.coreExecutable)) !== receipt.coreSha256
    || path.dirname(receipt.coreExecutable) !== path.dirname(receipt.executable)) {
    throw new Error('Core artifact receipt mismatch');
  }
  return receipt;
}
export function snapshot(project, output, profile, mode) {
  project = fs.realpathSync(project);
  const manifest = sourceManifest(project), fingerprint = digest(JSON.stringify(manifest));
  const buildId = crypto.randomUUID();
  fs.mkdirSync(output); // Never overwrite another candidate.
  const source = path.join(output, 'source'); fs.mkdirSync(source);
  for (const item of manifest) {
    if (item.deleted) continue;
    const bytes = fs.readFileSync(path.join(project, item.file));
    if (digest(bytes) !== item.sha256) throw new Error('Sources changed during snapshot');
    const dest = path.join(source, item.file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes, { flag: 'wx' });
  }
  if (sourceFingerprint(project) !== fingerprint) throw new Error('Working tree changed during snapshot');
  const state = { version: 1, project, profile, mode, head: git(project, 'rev-parse', 'HEAD').toString().trim(),
    sourceFingerprint: fingerprint, buildId, startedAt: new Date().toISOString(), source, manifest };
  fs.writeFileSync(path.join(output, 'inputs.json'), JSON.stringify(state, null, 2), { flag: 'wx' });
  return state;
}
export function finish(output, executable, coreExecutable, { requireIdentity = false } = {}) {
  const state = JSON.parse(fs.readFileSync(path.join(output, 'inputs.json'), 'utf8'));
  for (const item of state.manifest) {
    if (item.deleted) continue;
    if (digest(fs.readFileSync(path.join(state.source, item.file))) !== item.sha256) throw new Error(`Snapshot modified during build: ${item.file}`);
  }
  const bytes = fs.readFileSync(executable);
  // build.rs embeds the build UUID and fingerprint; a reused or foreign binary lacks them.
  if (requireIdentity && [state.buildId, state.sourceFingerprint].some(value => !bytes.includes(Buffer.from(value, 'utf8')))) {
    throw new Error('Executable does not embed this build identity; no valid receipt');
  }
  const destination = path.join(output, 'epigraph.exe'); fs.writeFileSync(destination, bytes, { flag: 'wx' });
  const core = fs.readFileSync(coreExecutable), coreDestination = path.join(output, 'epigraph-syncd.exe');
  fs.writeFileSync(coreDestination, core, { flag: 'wx' });
  const { manifest, source, ...receipt } = state;
  Object.assign(receipt, { executable: destination, executableSha256: digest(bytes), coreExecutable: coreDestination,
    coreSha256: digest(core), completedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'snapshot') console.log(JSON.stringify(snapshot(...args)));
  else if (action === 'finish') console.log(JSON.stringify(finish(args[0], args[1], args[2], { requireIdentity: args[3] === '--require-identity' })));
  else if (action === 'validate') console.log(JSON.stringify(validateReceipt(JSON.parse(fs.readFileSync(args[0], 'utf8')), { project: args[1], profile: args[2], mode: args[3] })));
  else if (action === 'fingerprint') console.log(sourceFingerprint(args[0]));
  else throw new Error('Unknown receipt operation');
}
