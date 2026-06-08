import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

async function collectProcessMemory() {
  const command = `
$rows = @()
$allProcs = @(Get-CimInstance Win32_Process)
$aethonSuwayomiPids = @{}
foreach ($p in $allProcs) {
  $cmd = [string]$p.CommandLine
  if ($p.Name -eq 'java.exe' -and $cmd -match 'aethon-main|suwayomi') {
    $aethonSuwayomiPids[[int]$p.ProcessId] = $true
  }
}

$procs = $allProcs | Where-Object { $_.Name -in @('aethon.exe','java.exe','jcef_helper.exe','msedgewebview2.exe') }
foreach ($p in $procs) {
  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if (-not $gp) { continue }
  $cmd = [string]$p.CommandLine
  $isAethonWebView = $cmd -match 'dev\\.moku\\.app|webview-exe-name=aethon\\.exe'
  $isSuwayomi = $cmd -match 'aethon-main|suwayomi'
  $isSuwayomiChild = $p.Name -eq 'jcef_helper.exe' -and $aethonSuwayomiPids.ContainsKey([int]$p.ParentProcessId)
  if ($p.Name -eq 'aethon.exe' -or $isAethonWebView -or $isSuwayomi -or $isSuwayomiChild) {
    $role = if ($p.Name -eq 'aethon.exe') {
      'aethon-rust'
    } elseif ($isSuwayomiChild) {
      'suwayomi-jcef'
    } elseif ($isSuwayomi) {
      'suwayomi-java'
    } elseif ($cmd -match '--type=([^ ]+)') {
      $Matches[1]
    } else {
      'webview-browser'
    }
    $rows += [pscustomobject]@{
      name = $p.Name
      pid = $p.ProcessId
      role = $role
      workingSetMb = [math]::Round($gp.WorkingSet64 / 1MB, 1)
      privateMb = [math]::Round($gp.PrivateMemorySize64 / 1MB, 1)
      cpuSeconds = if ($null -ne $gp.CPU) { [math]::Round($gp.CPU, 3) } else { $null }
      commandLine = $cmd
    }
  }
}
$rows | ConvertTo-Json -Depth 5
`;
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    command,
  ], { maxBuffer: 1024 * 1024 * 8 });
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function collectWebViewDiagnostics() {
  const cdp = argValue("--cdp", "http://127.0.0.1:9223");
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.connectOverCDP(cdp);
    const context = browser.contexts()[0];
    const page = context?.pages()[0];
    if (!context || !page) {
      await browser.close();
      return { available: false, error: "No WebView page found." };
    }

    if (hasFlag("--gc")) {
      const session = await context.newCDPSession(page);
      await session.send("HeapProfiler.collectGarbage");
      await page.waitForTimeout(500);
    }

    const diagnostics = await page.evaluate(() => ({
      title: document.title,
      url: location.href,
      state: window.__aethonAudit?.getState?.() ?? null,
      runtime: window.__AETHON_DIAGNOSTICS__?.getSnapshot?.() ?? null,
      memory: performance.memory ? {
        usedJsHeapMb: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024 * 10) / 10,
        totalJsHeapMb: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024 * 10) / 10,
        jsHeapLimitMb: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024 * 10) / 10,
      } : null,
      dom: {
        elements: document.querySelectorAll("*").length,
        images: document.images.length,
        canvases: document.querySelectorAll("canvas").length,
        runningAnimations: document.getAnimations().filter((animation) => animation.playState === "running").length,
      },
    }));
    await browser.close();
    return { available: true, cdp, forcedGc: hasFlag("--gc"), ...diagnostics };
  } catch (error) {
    return {
      available: false,
      cdp,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeProcesses(processes) {
  const byRole = new Map();
  for (const processInfo of processes) {
    const current = byRole.get(processInfo.role) ?? {
      role: processInfo.role,
      count: 0,
      workingSetMb: 0,
      privateMb: 0,
    };
    current.count += 1;
    current.workingSetMb += processInfo.workingSetMb;
    current.privateMb += processInfo.privateMb;
    byRole.set(processInfo.role, current);
  }

  const roles = [...byRole.values()]
    .map((entry) => ({
      ...entry,
      workingSetMb: Math.round(entry.workingSetMb * 10) / 10,
      privateMb: Math.round(entry.privateMb * 10) / 10,
    }))
    .sort((left, right) => right.workingSetMb - left.workingSetMb);

  return {
    totalWorkingSetMb: Math.round(processes.reduce((sum, processInfo) => sum + processInfo.workingSetMb, 0) * 10) / 10,
    totalPrivateMb: Math.round(processes.reduce((sum, processInfo) => sum + processInfo.privateMb, 0) * 10) / 10,
    roles,
  };
}

const processes = await collectProcessMemory();
const webView = await collectWebViewDiagnostics();
const result = {
  capturedAt: new Date().toISOString(),
  processSummary: summarizeProcesses(processes),
  processes: processes.sort((left, right) => right.workingSetMb - left.workingSetMb),
  webView,
};

console.log(JSON.stringify(result, null, 2));
