import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { control, attestPage } from './epigraph-session-client.mjs';

const [recordPath, endpoint, output] = process.argv.slice(2);
const browser = await chromium.connectOverCDP(endpoint);
const results = [];
try {
  const pages = browser.contexts().flatMap(c => c.pages());
  const matches = [];
  for (const page of pages) {
    try { matches.push({ guarded: await attestPage(page, recordPath), native: page }); } catch {}
  }
  if (matches.length !== 1) throw new Error('Actual application page missing or ambiguous');
  const { guarded, native } = matches[0];
  const launch = await guarded.evaluate(() => globalThis.__TAURI_INTERNALS__.invoke('get_launch_target'));
  results.push({ case: 'actual-page-native-attestation', status: 'PASS', launch });
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8').replace(/^\uFEFF/, ''));
  const receipt = JSON.parse(fs.readFileSync(record.ReceiptPath, 'utf8'));
  const serverUrl = receipt.mode === 'main' ? 'http://127.0.0.1:4567' : 'http://127.0.0.1:4667';
  if (launch.serverUrlOverride !== serverUrl) throw new Error('Actual launch profile differs from receipt');
  results.push({ case: 'exact-profile-selected', status: 'PASS', serverUrl });
  const fixture = path.dirname(output), peerFile = path.join(fixture, 'peer.json');
  if (fs.existsSync(peerFile)) {
    const peer = JSON.parse(fs.readFileSync(peerFile, 'utf8'));
    fs.writeFileSync(path.join(fixture, 'peer-ready.json'), JSON.stringify({ recordPath, endpoint, runId: record.RunId }), { flag: 'wx' });
    const waitPeer = async file => {
      const deadline = Date.now() + 30 * 60 * 1000;
      while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error('Concurrent candidate did not become ready');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    };
    const other = await waitPeer(path.join(peer.fixture, 'peer-ready.json'));
    if (other.runId === record.RunId) throw new Error('Concurrent verification requires another run');
    let rejected = false;
    try { await attestPage(native, other.recordPath); } catch { rejected = true; }
    if (!rejected) throw new Error('Foreign profile obtained authority over this connected page');
    results.push({ case: 'two-actual-profiles-concurrent-foreign-cdp-rejected', status: 'PASS', otherRun: other.runId });
    fs.writeFileSync(path.join(fixture, 'peer-checked.json'), JSON.stringify({ runId: record.RunId }), { flag: 'wx' });
    await waitPeer(path.join(peer.fixture, 'peer-checked.json'));
  }
  const core = await guarded.evaluate(() => globalThis.__TAURI_INTERNALS__.invoke('syncd_get_runtime_identity'));
  results.push({ case: 'actual-persistent-core-start', status: 'PASS', core });
  await guarded.evaluate(args => globalThis.__TAURI_INTERNALS__.invoke('prepare_managed_server_startup', args),
    { binary: '', serverUrl, profileId: null, profileLabel: null, updateIntensity: 'eco' });
  results.push({ case: 'actual-owned-runtime-start-request', status: 'PASS' });
  const install = await guarded.evaluate(async () => {
    try { await globalThis.__TAURI_INTERNALS__.invoke('download_and_install_update', { expectedVersion: 'b1-invalid-version-must-never-install' }); return 'accepted'; }
    catch (error) { return String(error); }
  });
  if (!install.includes('attested installer handoff')) throw new Error(`Installer bypass was not refused: ${install}`);
  results.push({ case: 'native-installer-refused-before-implicit-exit', status: 'PASS', outcome: install });
  for (const command of ['restart_app', 'relaunch_with_args']) {
    const outcome = await guarded.evaluate(async command => {
      try { await globalThis.__TAURI_INTERNALS__.invoke(command, command === 'relaunch_with_args' ? { args: [] } : {}); return 'accepted'; }
      catch (error) { return String(error); }
    }, command);
    if (!outcome.includes('Managed run')) throw new Error(`Unattested ${command} did not fail closed: ${outcome}`);
    results.push({ case: `${command}-requires-fresh-attested-run`, status: 'PASS', outcome });
  }
  const focus = await control(recordPath, 'focus');
  results.push({ case: 'exact-run-focus', status: focus.accepted ? 'PASS' : 'FAIL', detail: focus.detail });
  const placement = await control(recordPath, 'focus-main');
  results.push({ case: 'application-monitor-placement', status: placement.accepted ? 'PASS' : 'FAIL', detail: placement.detail });
  const alive = await guarded.evaluate(() => ({ title: document.title, native: Boolean(globalThis.__TAURI_INTERNALS__?.invoke) }));
  if (!alive.native) throw new Error('Native bridge disappeared');
  results.push({ case: 'guarded-dom-operation', status: 'PASS' });
  // A new document invalidates the previously granted DOM capability.
  await native.reload({ waitUntil: 'domcontentloaded' });
  let refused = false;
  try { await guarded.evaluate(() => { document.documentElement.dataset.b1ForeignMutation = 'unsafe'; }); } catch { refused = true; }
  if (!refused) throw new Error('Navigation retained old DOM authority');
  results.push({ case: 'navigation-rejects-stale-dom-authority', status: 'PASS' });
  const refreshed = await attestPage(native, recordPath);
  await refreshed.evaluate(() => Boolean(document.documentElement));
  results.push({ case: 'navigation-fresh-attestation', status: 'PASS' });
} catch (error) {
  results.push({ case: 'actual-application-interaction', status: 'FAIL', error: String(error) });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(output, JSON.stringify(results, null, 2));
  await browser.close();
}
