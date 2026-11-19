import { type Node, Parser, tokenizer } from "acorn";

/**
 * What the hosted code migration checks by reading the code, never by running it. A Worker cannot execute the
 * code it holds, so these checks look at its shape: which modules it imports, what it exports, and whether the
 * tests still test the same things. They are deterministic and each has a planted fault it must catch (faults.ts).
 */

/** The files of a project, by path relative to its root, as text. */
export type Files = Record<string, string>;

type AnyNode = Node & Record<string, unknown>;

const isJs = (path: string) => path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs");

/** Parses JavaScript as a module, or as a script when it is CommonJS. Returns null when it does not parse. */
export function parse(source: string): AnyNode | null {
  for (const sourceType of ["module", "script"] as const) {
    try {
      return Parser.parse(source, { ecmaVersion: "latest", sourceType, allowHashBang: true }) as unknown as AnyNode;
    } catch {
      // try the other source type
    }
  }
  return null;
}

/** Calls visit on every node of the tree. */
function walk(node: unknown, visit: (n: AnyNode) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  const n = node as AnyNode;
  if (typeof n.type !== "string") return;
  visit(n);
  for (const [key, value] of Object.entries(n)) if (key !== "loc" && key !== "range") walk(value, visit);
}

const isRequireCall = (n: AnyNode) => n.type === "CallExpression" && (n.callee as AnyNode).type === "Identifier" && (n.callee as AnyNode).name === "require";
const isModuleExports = (n: AnyNode) => n.type === "MemberExpression" && (n.object as AnyNode).type === "Identifier" && ((n.object as AnyNode).name === "module" || (n.object as AnyNode).name === "exports");

/** Every use of require, module.exports or exports in one file, as line numbers. */
export function commonJsUses(source: string): number[] {
  const tree = parse(source);
  if (!tree) return [];
  const lines = new Set<number>();
  const lineOf = (offset: number) => source.slice(0, offset).split("\n").length;
  walk(tree, (n) => {
    if (isRequireCall(n) || isModuleExports(n)) lines.add(lineOf(n.start));
  });
  return [...lines].sort((a, b) => a - b);
}

/** The files under a folder that use CommonJS, with the lines where they do. */
export function commonJsFiles(files: Files, folder: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [path, source] of Object.entries(files)) {
    if (!path.startsWith(folder) || !isJs(path)) continue;
    const uses = commonJsUses(source);
    if (uses.length > 0) out[path] = uses;
  }
  return out;
}

/** Resolves a relative module specifier from one file to a path in the project. */
export function resolve(from: string, specifier: string): string {
  const parts = from.split("/").slice(0, -1);
  for (const piece of specifier.split("/")) {
    if (piece === "." || piece === "") continue;
    if (piece === "..") parts.pop();
    else parts.push(piece);
  }
  return parts.join("/");
}

/** Every relative import and re-export in the project that does not point to a file that exists. */
export function unresolvedImports(files: Files): { file: string; specifier: string }[] {
  const missing: { file: string; specifier: string }[] = [];
  for (const [path, source] of Object.entries(files)) {
    if (!isJs(path)) continue;
    const tree = parse(source);
    if (!tree) {
      missing.push({ file: path, specifier: "(the file does not parse)" });
      continue;
    }
    walk(tree, (n) => {
      const isModuleSource = n.type === "ImportDeclaration" || ((n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && n.source);
      const fromRequire = isRequireCall(n) && ((n.arguments as AnyNode[])[0]?.type === "Literal") ? ((n.arguments as AnyNode[])[0] as AnyNode).value : null;
      const specifier = isModuleSource ? ((n.source as AnyNode).value as string) : typeof fromRequire === "string" ? fromRequire : null;
      if (!specifier?.startsWith(".")) return;
      const target = resolve(path, specifier);
      // CommonJS may leave out the extension. An ES module import must name the file exactly.
      const candidates = isModuleSource ? [target] : [target, `${target}.js`, `${target}/index.js`];
      if (!candidates.some((c) => c in files)) missing.push({ file: path, specifier });
    });
  }
  return missing;
}

/** One exported name of a module, with the number of parameters when it is a function. */
export type Export = { name: string; params: number | null };

/** The functions declared at the top of a file, with their parameter counts. */
function declaredFunctions(tree: AnyNode): Map<string, number> {
  const out = new Map<string, number>();
  for (const stmt of tree.body as AnyNode[]) {
    const decl = stmt.type === "ExportNamedDeclaration" || stmt.type === "ExportDefaultDeclaration" ? (stmt.declaration as AnyNode | null) : stmt;
    if (!decl) continue;
    if (decl.type === "FunctionDeclaration" && decl.id) out.set((decl.id as AnyNode).name as string, (decl.params as unknown[]).length);
    if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations as AnyNode[]) {
        const init = d.init as AnyNode | null;
        if ((d.id as AnyNode).type === "Identifier" && init && (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")) out.set((d.id as AnyNode).name as string, (init.params as unknown[]).length);
      }
    }
  }
  return out;
}

/** The names a CommonJS or ES module file exports, each with its parameter count when it is a local function. */
export function exportsOf(source: string): Export[] {
  const tree = parse(source);
  if (!tree) return [];
  const fns = declaredFunctions(tree);
  const names = new Set<string>();
  for (const stmt of tree.body as AnyNode[]) {
    if (stmt.type === "ExportNamedDeclaration") {
      const decl = stmt.declaration as AnyNode | null;
      if (decl?.type === "FunctionDeclaration") names.add((decl.id as AnyNode).name as string);
      if (decl?.type === "VariableDeclaration") for (const d of decl.declarations as AnyNode[]) if ((d.id as AnyNode).type === "Identifier") names.add((d.id as AnyNode).name as string);
      for (const s of (stmt.specifiers as AnyNode[]) ?? []) names.add(((s.exported as AnyNode).name ?? (s.exported as AnyNode).value) as string);
    }
    if (stmt.type === "ExportDefaultDeclaration") names.add("default");
    // module.exports = { a, b } or module.exports = value
    if (stmt.type === "ExpressionStatement" && (stmt.expression as AnyNode).type === "AssignmentExpression") {
      const assign = stmt.expression as AnyNode;
      const left = assign.left as AnyNode;
      if (isModuleExports(left) && (left.object as AnyNode).name === "module" && ((left.property as AnyNode).name === "exports")) {
        const right = assign.right as AnyNode;
        if (right.type === "ObjectExpression") {
          for (const p of right.properties as AnyNode[]) if (p.type === "Property") names.add(((p.key as AnyNode).name ?? (p.key as AnyNode).value) as string);
        } else names.add("default");
      } else if (isModuleExports(left) && (left.property as AnyNode).type === "Identifier") names.add((left.property as AnyNode).name as string);
    }
  }
  return [...names].sort().map((name) => ({ name, params: fns.get(name) ?? null }));
}

/**
 * The public functions of the service as callers see them: the names that the entry file exports, each followed
 * through its re-export or import to the file that declares it, with its parameter count.
 */
export function publicApi(files: Files, entry: string): Export[] {
  const source = files[entry];
  if (source === undefined) return [];
  const tree = parse(source);
  if (!tree) return [];
  // Where each local name of the entry file comes from: a module path and the name there.
  const origin = new Map<string, { path: string; name: string }>();
  const fromModule = (specifier: string, cjs: boolean) => {
    const target = resolve(entry, specifier);
    return cjs ? ([target, `${target}.js`].find((c) => c in files) ?? target) : target;
  };
  for (const stmt of tree.body as AnyNode[]) {
    if (stmt.type === "ImportDeclaration") {
      for (const s of stmt.specifiers as AnyNode[]) origin.set((s.local as AnyNode).name as string, { path: fromModule((stmt.source as AnyNode).value as string, false), name: s.type === "ImportSpecifier" ? (((s.imported as AnyNode).name ?? (s.imported as AnyNode).value) as string) : "default" });
    }
    if (stmt.type === "VariableDeclaration") {
      for (const d of stmt.declarations as AnyNode[]) {
        const init = d.init as AnyNode | null;
        const spec = init && isRequireCall(init) ? ((init.arguments as AnyNode[])[0] as AnyNode).value : null;
        if (typeof spec !== "string") continue;
        const path = fromModule(spec, true);
        if ((d.id as AnyNode).type === "ObjectPattern") for (const p of (d.id as AnyNode).properties as AnyNode[]) origin.set((p.value as AnyNode).name as string, { path, name: (p.key as AnyNode).name as string });
        if ((d.id as AnyNode).type === "Identifier") origin.set((d.id as AnyNode).name as string, { path, name: "default" });
      }
    }
    if (stmt.type === "ExportNamedDeclaration" && stmt.source) {
      for (const s of stmt.specifiers as AnyNode[]) origin.set(((s.exported as AnyNode).name ?? (s.exported as AnyNode).value) as string, { path: fromModule((stmt.source as AnyNode).value as string, false), name: ((s.local as AnyNode).name ?? (s.local as AnyNode).value) as string });
    }
  }
  const paramsIn = (path: string, name: string): number | null => {
    const src = files[path];
    const t = src === undefined ? null : parse(src);
    return t ? (declaredFunctions(t).get(name) ?? null) : null;
  };
  return exportsOf(source).map(({ name, params }) => {
    const from = origin.get(name);
    return { name, params: params ?? (from ? paramsIn(from.path, from.name) : null) };
  });
}

/** The token text of a file, leaving out the statements that only load modules: imports and require lines. */
export function tokensWithoutImports(source: string): string[] | null {
  const tree = parse(source);
  if (!tree) return null;
  const skip: [number, number][] = [];
  for (const stmt of tree.body as AnyNode[]) {
    if (stmt.type === "ImportDeclaration") skip.push([stmt.start, stmt.end]);
    if (stmt.type === "VariableDeclaration" && (stmt.declarations as AnyNode[]).every((d) => d.init && isRequireCall(d.init as AnyNode))) skip.push([stmt.start, stmt.end]);
  }
  const kept: string[] = [];
  const sourceType = source.includes("import ") || source.includes("export ") ? "module" : "script";
  for (const token of tokenizer(source, { ecmaVersion: "latest", sourceType })) {
    if (skip.some(([a, b]) => token.start >= a && token.end <= b)) continue;
    kept.push(source.slice(token.start, token.end));
  }
  return kept;
}

/** The test files whose tests changed, beyond the lines that load modules. */
export function changedTests(before: Files, after: Files, folder: string): string[] {
  const changed: string[] = [];
  for (const path of Object.keys(before)) {
    if (!path.startsWith(folder) || !isJs(path)) continue;
    const a = tokensWithoutImports(before[path] ?? "");
    const b = after[path] === undefined ? null : tokensWithoutImports(after[path]);
    if (!a || !b || a.length !== b.length || a.some((t, i) => t !== b[i])) changed.push(path);
  }
  return changed;
}
