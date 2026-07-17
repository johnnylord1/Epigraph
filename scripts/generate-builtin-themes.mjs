import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "vite";

const checkOnly = process.argv.slice(2).includes("--check");
const root = process.cwd();
const outputPath = resolve(root, "src/styles/builtin-themes.generated.css");
let server;

try {
  server = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "error",
    server: { middlewareMode: true },
  });
  const { renderBuiltinThemesCss } = await server.ssrLoadModule("/src/lib/theme/builtinCss.ts");
  const expected = renderBuiltinThemesCss();

  if (checkOnly) {
    const actual = await readFile(outputPath, "utf8").catch(() => "");
    if (actual !== expected) {
      throw new Error("Generated builtin CSS is stale. Run pnpm theme:generate-builtins.");
    }
    process.stdout.write("Generated builtin CSS is current.\n");
  } else {
    await writeFile(outputPath, expected, "utf8");
    process.stdout.write("Generated src/styles/builtin-themes.generated.css.\n");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await server?.close();
}
