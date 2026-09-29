import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const tools = path.join(path.dirname(fileURLToPath(import.meta.url)), 'EpigraphSessionTools.ps1');

export async function control(recordPath, action, extra = {}) {
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8').replace(/^\uFEFF/, ''));
  const input = Buffer.from(JSON.stringify({ tools, recordPath, record, action, ...extra })).toString('base64');
  const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json;. $p.tools;$r=@{Project=$p.record.Project;Profile=$p.record.Profile;Build=$p.record.Build;RunId=$p.record.RunId};Invoke-EpigraphSessionControl $r $p.action (Split-Path -Parent $p.recordPath) 30000 $p.challenge $p.proof|ConvertTo-Json -Compress`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 65000 });
  return JSON.parse(stdout.trim());
}

export async function attestPage(page, recordPath) {
  const challenge = await control(recordPath, 'challenge');
  const key = `__epigraph_attested_${crypto.randomUUID().replaceAll('-', '')}`;
  const token = crypto.randomUUID();
  const proof = await page.evaluate(async ({ nonce, key, token }) => {
    const invoke = globalThis.__TAURI_INTERNALS__?.invoke;
    if (!invoke) throw new Error('No native application bridge');
    const value = await invoke('session_page_attestation', { nonce });
    Object.defineProperty(globalThis, key, { value: token, writable: false, configurable: false });
    return value;
  }, { nonce: challenge.nonce, key, token });
  if (proof.runId !== challenge.runId || proof.nonce !== challenge.nonce) throw new Error('Connected page belongs to another run');
  const verified = await control(recordPath, 'verify-page', { challenge: challenge.nonce, proof: proof.proof });
  if (verified.document !== proof.document) throw new Error('Document changed during attestation');
  const evaluate = page.evaluate.bind(page);
  // Every later evaluation checks the capability in the same JS execution context
  // as the operation. Navigation destroys it; a Page object reused for a new
  // document cannot silently retain authority. No browser security flags change.
  const guarded = {
    evaluate: (fn, arg) => evaluate(({ source, arg, key, token }) => {
      if (globalThis[key] !== token) throw new Error('Page navigated; fresh native attestation required');
      return (0, eval)(`(${source})`)(arg);
    }, { source: fn.toString(), arg, key, token }),
    waitForTimeout: ms => page.waitForTimeout(ms),
    screenshot: async options => {
      await evaluate(({ key, token }) => { if (globalThis[key] !== token) throw new Error('Page changed'); }, { key, token });
      const { path: destination, ...settings } = options ?? {};
      const bytes = await page.screenshot(settings);
      const after = await control(recordPath, 'attest');
      await evaluate(({ key, token }) => { if (globalThis[key] !== token) throw new Error('Page changed during capture'); }, { key, token });
      if (after.document !== proof.document) throw new Error('Native document changed during capture');
      if (destination) fs.writeFileSync(destination, bytes);
      return bytes;
    },
  };
  const bindLocator = locator => ({
    first: () => bindLocator(locator.first()), nth: index => bindLocator(locator.nth(index)),
    count: async () => { await guarded.evaluate(() => true); return locator.count(); },
    isVisible: async () => {
      const element = await locator.elementHandle(); if (!element) return false;
      try { await element.evaluate((node, { key, token }) => { if (node.ownerDocument.defaultView[key] !== token) throw new Error('Document changed'); }, { key, token }); return await element.isVisible(); }
      finally { await element.dispose(); }
    },
    waitFor: async options => { await locator.waitFor(options); await guarded.evaluate(() => true); },
    click: async options => {
      const element = await locator.elementHandle(); if (!element) throw new Error('Target absent');
      try {
        await element.evaluate((node, { key, token, options }) => {
          if (!node.isConnected || node.ownerDocument.defaultView[key] !== token) throw new Error('Document changed');
          // Check and dispatch within one JS execution context. Native coordinate
          // clicks would introduce a new document/target lookup after this check.
          if (options?.button === 'right') node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
          else node.click();
        }, { key, token, options });
      } finally { await element.dispose(); }
    },
    screenshot: async options => {
      const element = await locator.elementHandle(); if (!element) throw new Error('Target absent');
      try {
        await element.evaluate((node, { key, token }) => { if (node.ownerDocument.defaultView[key] !== token) throw new Error('Document changed'); }, { key, token });
        const { path: destination, ...settings } = options ?? {};
        const bytes = await element.screenshot(settings);
        const after = await control(recordPath, 'attest');
        await element.evaluate((node, { key, token }) => { if (node.ownerDocument.defaultView[key] !== token) throw new Error('Document changed during capture'); }, { key, token });
        if (after.document !== proof.document) throw new Error('Native document changed during capture');
        if (destination) fs.writeFileSync(destination, bytes);
        return bytes;
      } finally { await element.dispose(); }
    },
  });
  guarded.locator = selector => bindLocator(page.locator(selector));
  guarded.getByRole = (role, options) => bindLocator(page.getByRole(role, options));
  guarded.keyboard = { press: key => guarded.evaluate(key => {
    if (key !== 'Escape') throw new Error('Unsupported attested keyboard action');
    const target = document.activeElement ?? document;
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  }, key) };
  guarded.mouse = { move: (x, y) => guarded.evaluate(({ x, y }) => {
    document.elementFromPoint(x, y)?.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
  }, { x, y }) };
  guarded.waitForFunction = async (fn, arg, options = {}) => {
    const end = Date.now() + (options.timeout ?? 30000);
    do { if (await guarded.evaluate(fn, arg)) return; await page.waitForTimeout(100); } while (Date.now() < end);
    throw new Error('Attested page condition timed out');
  };
  return guarded;
}

export async function findAttestedPage(browser, recordPath) {
  const matches = [];
  for (const page of browser.contexts().flatMap(context => context.pages())) {
    try { matches.push(await attestPage(page, recordPath)); } catch {}
  }
  if (matches.length !== 1) throw new Error('No unique native-attested application page on this connection');
  return matches[0];
}
