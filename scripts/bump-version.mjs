import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+([ab]|rc)?\d*$/.test(version ?? "")) {
  console.error("usage: npm run bump -- 0.1.2");
  process.exit(1);
}

const pkgPath = new URL("../package.json", import.meta.url);
const pyPath = new URL("../local-bridge/pyproject.toml", import.meta.url);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const py = readFileSync(pyPath, "utf8");
const line = /^version = ".*"$/m;
if (!line.test(py)) {
  console.error("no version line in pyproject.toml");
  process.exit(1);
}
writeFileSync(pyPath, py.replace(line, `version = "${version}"`));

console.log(`set ${version} in package.json and pyproject.toml

next:
  git commit -am "release v${version}"
  git tag -a v${version} -m "IFCViewX ${version}"
  git push origin main --follow-tags`);
