import fs from "node:fs";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument pair near '${key ?? ""}'`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));
const endpoint = args.endpoint;
const token = args.token;
const scopeId = args.scopeId;
const outputPath = args.outputPath;
const timeoutSeconds = Number.parseInt(args.timeoutSeconds ?? "15", 10);
const lastEventId = args.lastEventId ?? "";
const maxEvents = Number.parseInt(args.maxEvents ?? "0", 10);

if (!endpoint || !token || !scopeId || !outputPath) {
  throw new Error("Missing required args: --endpoint --token --scopeId --outputPath");
}

const url = new URL(`${endpoint}/v1/events`);
url.searchParams.set("scopeId", scopeId);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort("timeout"), timeoutSeconds * 1000);
let stream;

try {
  fs.writeFileSync(outputPath, "");
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Epigraph-Client-Version": "0.1.0",
      "X-Epigraph-Client-Protocol-Version": "1",
      ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
    },
    signal: controller.signal,
  });

  if (!response.ok) {
    const body = await response.text();
    fs.writeFileSync(outputPath, body);
    process.exitCode = 1;
  } else if (!response.body) {
    throw new Error("SSE response body missing");
  } else {
    stream = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let eventCount = 0;

    while (true) {
      const { done, value } = await stream.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      pending += chunk;
      fs.appendFileSync(outputPath, chunk);
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventCount += 1;
        }
      }

      if (maxEvents > 0 && eventCount >= maxEvents) {
        controller.abort("max-events");
        break;
      }
    }
  }
} catch (error) {
  if (error !== "timeout" && error !== "max-events" && error?.name !== "AbortError") {
    throw error;
  }
} finally {
  clearTimeout(timeout);
  if (stream) {
    try {
      await stream.cancel();
    } catch {}
  }
}
