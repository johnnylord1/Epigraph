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
const sessionId = args.sessionId;
const pairingCode = args.pairingCode;
const outputPath = args.outputPath;
const readyPath = args.readyPath;
const timeoutSeconds = Number.parseInt(args.timeoutSeconds ?? "20", 10);
const maxEvents = Number.parseInt(args.maxEvents ?? "0", 10);

if (!endpoint || !sessionId || !pairingCode || !outputPath) {
  throw new Error(
    "Missing required args: --endpoint --sessionId --pairingCode --outputPath",
  );
}

const wsUrl = new URL(
  `${endpoint.replace(/^http/i, "ws")}/v1/bootstrap/session/${sessionId}/live`,
);
wsUrl.searchParams.set("pairingCode", pairingCode);

const events = [];
fs.writeFileSync(outputPath, "[]");

await new Promise((resolve, reject) => {
  const socket = new WebSocket(wsUrl);
  const timeout = setTimeout(() => {
    try {
      socket.close();
    } catch {}
    reject(new Error("Timed out waiting for pairing websocket events"));
  }, timeoutSeconds * 1000);

  socket.addEventListener("open", () => {
    if (readyPath) {
      fs.writeFileSync(readyPath, "open");
    }
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(String(event.data));
    events.push(payload);
    fs.writeFileSync(outputPath, JSON.stringify(events, null, 2));
    if (maxEvents > 0 && events.length >= maxEvents) {
      socket.close();
    }
  });

  socket.addEventListener("close", () => {
    clearTimeout(timeout);
    fs.writeFileSync(outputPath, JSON.stringify(events, null, 2));
    resolve();
  });

  socket.addEventListener("error", (event) => {
    clearTimeout(timeout);
    reject(event.error ?? new Error("pairing websocket failed"));
  });
});
