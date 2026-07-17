import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

function parseArguments(argv) {
  const args = [...argv];
  const candidate = args.shift();
  let output;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag !== "--out" || args.length === 0 || output) {
      throw new Error("Usage: pnpm theme:validate-promotion -- <candidate.json> [--out <package.json>]");
    }
    output = args.shift();
  }
  if (!candidate) throw new Error("Usage: pnpm theme:validate-promotion -- <candidate.json> [--out <package.json>]");
  return { candidate, output };
}

const root = process.cwd();
let server;

try {
  const { candidate, output } = parseArguments(process.argv.slice(2));
  server = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "error",
    server: { middlewareMode: true },
  });
  const { validateThemePromotionFile } = await server.ssrLoadModule("/src/lib/theme/promotion.node.ts");
  const result = validateThemePromotionFile(candidate, root);
  if (!result.ok) {
    for (const error of result.errors) process.stderr.write(`${error.code} ${error.path}: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    const serialized = `${JSON.stringify(result.package, null, 2)}\n`;
    if (output) {
      await writeFile(resolve(root, output), serialized, "utf8");
      process.stdout.write(`Theme promotion package written to ${output}.\n`);
    } else {
      process.stdout.write(serialized);
    }
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await server?.close();
}
