import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const version = args[checkOnly ? 1 : 0];
// This subset is valid in both npm SemVer and Python's PEP 440. The previous
// Python-only `0.1.2rc1` form left package.json with an invalid npm version.
if (!/^\d+\.\d+\.\d+(?:-(?:a|b|rc)\.\d+)?$/.test(version ?? "")) {
  console.error("usage: npm run bump -- 0.1.2\n       node scripts/bump-version.mjs --check 0.1.2");
  process.exit(1);
}

const pkgPath = new URL("../package.json", import.meta.url);
const lockPath = new URL("../package-lock.json", import.meta.url);
const pyPath = new URL("../local-bridge/pyproject.toml", import.meta.url);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
if (!lock.packages?.[""]) {
  console.error("package-lock.json has no root package metadata");
  process.exit(1);
}

const py = readFileSync(pyPath, "utf8");
const line = /^version = ".*"$/m;
const pyVersion = /^version = "(.*)"$/m.exec(py)?.[1];
if (!pyVersion) {
  console.error("no version line in pyproject.toml");
  process.exit(1);
}

if (checkOnly) {
  const versions = new Map([
    ["package.json", pkg.version],
    ["package-lock.json", lock.version],
    ["package-lock.json root package", lock.packages[""].version],
    ["local-bridge/pyproject.toml", pyVersion],
  ]);
  const mismatches = [...versions].filter(([, value]) => value !== version);
  if (mismatches.length) {
    for (const [file, value] of mismatches) console.error(`${file} is ${value ?? "missing"}; expected ${version}`);
    process.exit(1);
  }
  console.log(`all release metadata is ${version}`);
  process.exit(0);
}

pkg.version = version;
lock.version = version;
lock.packages[""].version = version;

// Validate every input before writing any of them, then keep npm and Python
// release metadata in one operation.
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
writeFileSync(pyPath, py.replace(line, `version = "${version}"`));

console.log(`set ${version} in package.json, package-lock.json and pyproject.toml

next:
  git status --short
  git add -A
  git diff --cached --check
  git commit -m "release v${version}"
  git tag -a v${version} -m "IFCViewX ${version}"
  git push origin main --follow-tags`);
