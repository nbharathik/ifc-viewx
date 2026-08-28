import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

/** Collect every literal ESM import and re-export from a TypeScript module. */
export function moduleSpecifiers(source, fileName = "plugin.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = [
    ...file.referencedFiles.map((reference) => reference.fileName),
    ...file.typeReferenceDirectives.map((reference) => reference.fileName),
  ];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length >= 1 && ts.isStringLiteralLike(node.arguments[0])) {
      found.push(node.arguments[0].text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push(node.moduleReference.expression.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)) {
      found.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** A computed import cannot be proven to remain inside the plugin package. */
export function hasNonLiteralDynamicImport(source, fileName = "plugin.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        (node.arguments.length < 1 || !ts.isStringLiteralLike(node.arguments[0]))) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Return null for an allowed plugin import, or a user-facing violation. */
export function pluginImportProblem(pluginDir, importingFile, specifier) {
  if (specifier === "@ifcviewx/sdk") return null;
  if (!specifier.startsWith(".") || isAbsolute(specifier)) {
    return `imports "${specifier}"; plugins may only import "@ifcviewx/sdk" and their own files`;
  }

  const root = resolve(pluginDir);
  const target = resolve(dirname(importingFile), specifier);
  const fromRoot = relative(root, target);
  const escapes = fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  return escapes
    ? `imports "${specifier}" outside its plugin folder; plugins may only import "@ifcviewx/sdk" and their own files`
    : null;
}

/** Return the plugin folder reached by a core import, if any. */
export function importedPluginId(specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const normalized = specifier.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
  const id = /(?:^|\/)plugins\/([^/]+)(?:\/|$)/.exec(normalized)?.[1];
  return id && /^[a-z][a-z0-9-]*$/.test(id) ? id : null;
}
