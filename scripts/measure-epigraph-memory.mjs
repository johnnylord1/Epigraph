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

function numericArgValue(name, fallback) {
  const raw = argValue(name, null);
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectProcessMemory() {
  const command = `
$rows = @()
$allProcs = @(Get-CimInstance Win32_Process)
$epigraphSuwayomiPids = @{}
foreach ($p in $allProcs) {
  $cmd = [string]$p.CommandLine
  if ($p.Name -eq 'java.exe' -and $cmd -match 'epigraph-main|suwayomi') {
    $epigraphSuwayomiPids[[int]$p.ProcessId] = $true
  }
}

$procs = $allProcs | Where-Object { $_.Name -in @('epigraph.exe','java.exe','jcef_helper.exe','msedgewebview2.exe') }
foreach ($p in $procs) {
  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if (-not $gp) { continue }
  $cmd = [string]$p.CommandLine
  $isEpigraphWebView = $cmd -match 'dev\\.epigraph\\.app|webview-exe-name=epigraph\\.exe'
  $isSuwayomi = $cmd -match 'epigraph-main|suwayomi'
  $isSuwayomiChild = $p.Name -eq 'jcef_helper.exe' -and $epigraphSuwayomiPids.ContainsKey([int]$p.ParentProcessId)
  if ($p.Name -eq 'epigraph.exe' -or $isEpigraphWebView -or $isSuwayomi -or $isSuwayomiChild) {
    $role = if ($p.Name -eq 'epigraph.exe') {
      'epigraph-rust'
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
    const pages = context?.pages() ?? [];
    const page = pages.find((candidate) => {
      const url = candidate.url();
      return url.includes("127.0.0.1:1420")
        && !url.includes("novelRuntimeHost=1")
        && !url.includes("replyToLabel=");
    }) ?? pages.find((candidate) => !candidate.url().includes("novelRuntimeHost=1")) ?? pages[0];
    if (!context || !page) {
      await browser.close();
      return { available: false, error: "No WebView page found." };
    }

    if (hasFlag("--gc")) {
      const session = await context.newCDPSession(page);
      await session.send("HeapProfiler.collectGarbage");
      await page.waitForTimeout(500);
    }

    const diagnostics = await page.evaluate(async () => {
      const runtime = window.__EPIGRAPH_DIAGNOSTICS__?.getSnapshot?.() ?? null;
      let backend = null;
      let libraryUpdateStatus = null;

      try {
        backend = await window.__EPIGRAPH_DIAGNOSTICS__?.getBackendSnapshot?.();
      } catch (error) {
        backend = { error: error instanceof Error ? error.message : String(error) };
      }

      const serverUrl = runtime?.serverUrl ?? window.__epigraphAudit?.getState?.()?.serverUrl;
      if (serverUrl) {
        try {
          const response = await fetch(`${serverUrl}/api/graphql`, {
            method: "POST",
            cache: "no-store",
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-cache",
            },
            body: JSON.stringify({
              query: `
                query MeasureLibraryUpdateStatus {
                  libraryUpdateStatus {
                    jobsInfo {
                      isRunning
                      finishedJobs
                      totalJobs
                      skippedCategoriesCount
                      skippedMangasCount
                    }
                  }
                }
              `,
            }),
          });
          const json = await response.json();
          libraryUpdateStatus = json.data?.libraryUpdateStatus?.jobsInfo ?? null;
        } catch (error) {
          libraryUpdateStatus = { error: error instanceof Error ? error.message : String(error) };
        }
      }

      return {
        title: document.title,
        url: location.href,
        state: window.__epigraphAudit?.getState?.() ?? null,
        runtime,
        backend,
        libraryUpdateStatus,
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
      };
    });
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

function summarizeIdleCpu(before, after, elapsedMs) {
  if (elapsedMs <= 0) return null;
  const beforeByPid = new Map(before.map((entry) => [entry.pid, entry]));
  const rows = after
    .map((entry) => {
      const previous = beforeByPid.get(entry.pid);
      if (!previous || typeof previous.cpuSeconds !== "number" || typeof entry.cpuSeconds !== "number") {
        return null;
      }
      const cpuSecondsDelta = Math.max(0, entry.cpuSeconds - previous.cpuSeconds);
      return {
        pid: entry.pid,
        role: entry.role,
        name: entry.name,
        cpuSecondsDelta: Math.round(cpuSecondsDelta * 1000) / 1000,
        cpuPercentOneCore: Math.round((cpuSecondsDelta / (elapsedMs / 1000)) * 1000) / 10,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.cpuSecondsDelta - left.cpuSecondsDelta);

  const byRole = new Map();
  for (const row of rows) {
    const current = byRole.get(row.role) ?? { role: row.role, cpuSecondsDelta: 0, cpuPercentOneCore: 0 };
    current.cpuSecondsDelta += row.cpuSecondsDelta;
    current.cpuPercentOneCore += row.cpuPercentOneCore;
    byRole.set(row.role, current);
  }

  return {
    elapsedMs,
    totalCpuPercentOneCore: Math.round(rows.reduce((sum, row) => sum + row.cpuPercentOneCore, 0) * 10) / 10,
    roles: [...byRole.values()]
      .map((entry) => ({
        role: entry.role,
        cpuSecondsDelta: Math.round(entry.cpuSecondsDelta * 1000) / 1000,
        cpuPercentOneCore: Math.round(entry.cpuPercentOneCore * 10) / 10,
      }))
      .sort((left, right) => right.cpuPercentOneCore - left.cpuPercentOneCore),
    processes: rows,
  };
}

const idleMs = numericArgValue("--idle-ms", 0);
const processes = await collectProcessMemory();
let idleCpu = null;
if (idleMs > 0) {
  await sleep(idleMs);
  const idleProcesses = await collectProcessMemory();
  idleCpu = summarizeIdleCpu(processes, idleProcesses, idleMs);
}
const webView = await collectWebViewDiagnostics();
const result = {
  capturedAt: new Date().toISOString(),
  processSummary: summarizeProcesses(processes),
  idleCpu,
  processes: processes.sort((left, right) => right.workingSetMb - left.workingSetMb),
  webView,
};

console.log(JSON.stringify(result, null, 2));
