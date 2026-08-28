import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(ROOT, "src/sdk/index.ts");
const GLOBALS = resolve(ROOT, "src/globals.d.ts");
const SNAPSHOT = resolve(ROOT, "tests/contracts/sdk-type-contracts.json");
const slash = (value) => value.replaceAll("\\", "/");
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function collectSdkTypeContracts() {
  const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) throw new Error("tsconfig.json was not found");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const program = ts.createProgram([ENTRY, GLOBALS], {
    ...parsed.options,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    incremental: false,
    composite: false,
  });
  const outputs = [];
  const emitted = program.emit(undefined, (path, content) => {
    const normalized = content.replaceAll("\r\n", "\n");
    outputs.push({
      path: slash(relative(ROOT, path)),
      bytes: Buffer.byteLength(normalized),
      sha256: digest(normalized),
    });
  }, undefined, true);
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter((item) => item.category === ts.DiagnosticCategory.Error);
  if (emitted.emitSkipped || diagnostics.length) {
    throw new Error(ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (value) => value,
      getCurrentDirectory: () => ROOT,
      getNewLine: () => "\n",
    }));
  }
  outputs.sort((a, b) => compareText(a.path, b.path));
  const combined = outputs.map((item) => `${item.path}\0${item.sha256}`).join("\n");
  return {
    schemaVersion: 1,
    typescriptVersion: ts.version,
    entry: "src/sdk/index.ts",
    digest: digest(combined),
    files: outputs,
  };
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function main() {
  const next = json(collectSdkTypeContracts());
  if (process.argv.includes("--check")) {
    const current = await readFile(SNAPSHOT, "utf8").catch(() => "");
    if (current !== next) {
      console.error("SDK type contracts changed. Review the declarations, then run npm run contracts:types:update.");
      process.exitCode = 1;
      return;
    }
    console.log("SDK type contract snapshot is current.");
    return;
  }
  if (process.argv.includes("--write")) {
    await writeFile(SNAPSHOT, next, "utf8");
    console.log(`Wrote ${slash(relative(ROOT, SNAPSHOT))}.`);
    return;
  }
  process.stdout.write(next);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
