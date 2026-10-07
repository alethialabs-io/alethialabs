#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// A CONSOLE TEST THAT READS A FILE TURBO DOES NOT HASH IS REPLAYED GREEN FROM CACHE (#5638).
//
// CI runs the console suite as `turbo run test`, with `.turbo/cache` restored from earlier runs.
// `console#test`'s cache key is the files turbo hashes for it: the package's own files minus
// `**/*.md(x)` (the root turbo.json), whatever apps/console/turbo.json adds, and the hashes of the
// workspace packages it depends on. A test that reads a file OUTSIDE that set — the Go catalog, an
// infra template, the deploy workflow, a docs/legal page — gets a cache hit on a PR that changes
// only that file, and turbo replays the old green log. Most of those tests are parity guards whose
// whole point is to fail when the OTHER side changes, so the cache disarmed exactly them. Measured
// on dev: `console#test` hashed `c6e85243bcd9d230` both before and after an edit to
// packages/core/catalog/catalog.json, and again after an edit to docs/legal/GDPR_ACCOUNTABILITY.md.
//
// ── WHAT THIS ASKS ──────────────────────────────────────────────────────────────────────────────
//
// Every repo file a console unit test reaches must be in `console#test`'s turbo input set. Both
// halves are DERIVED, neither is typed here:
//
//   READS   Start at the files `vitest list --filesOnly` says the default suite runs (plus the
//           config's setupFiles), walk their relative and `@/` imports transitively — into
//           apps/console and out of it — and in every module reached evaluate the path
//           expressions that are anchored to a location: `__dirname`, `import.meta.url` /
//           `import.meta.dirname`, `process.cwd()` (apps/console under turbo), and a relative
//           literal handed straight to an `fs` read. Anchored expressions are folded through
//           `path.join` / `resolve` / `dirname`, `fileURLToPath`, `new URL(x, import.meta.url)`,
//           `const` bindings, and calls to local single-expression helpers such as
//           `const repo = (...p) => resolve(__dirname, "../..", ...p)`. Then:
//             - a path that lands on a tracked FILE is a read;
//             - a template substitution that will not fold becomes `*` within that one segment,
//               so `fixture.${cloud}.json` reads every file it can match;
//             - at an `fs` read, a known non-root directory joined with segments that will not
//               fold (`join(FIXTURES, name)`) reads `<dir>/*`;
//             - a directory handed to an `fs` read (`readdirSync`) reads every file under it —
//               its listing changes exactly when one is added or removed;
//             - a relative import that lands outside apps/console is a read (vitest loads it;
//               turbo never sees it);
//             - a string literal spelling a tracked repo path outside apps/console (with a `/`)
//               is a read when it sits in a module that reads files, or in a module a test
//               imports directly while that test reads `resolve(REPO_ROOT, <data>)` — the
//               `it.each` row or lib constant the read's path actually came from.
//           Path expressions are taken from the WHOLE module, including functions no test calls,
//           so the set over-approximates: an extra entry costs a cache miss, a missing one costs
//           a replayed green.
//
//   HASHED  `turbo run test --filter=console --dry=json`: the `inputs` of `console#test` and of
//           every task it transitively depends on (`^build` of each workspace package — whose
//           files therefore ARE in the key, so a `@repo/*` import is covered without a line here).
//           This is turbo's own answer, not a reimplementation of its glob rules, which is why
//           the markdown question below could be measured rather than assumed.
//
// Any read missing from HASHED fails, naming the test and the `$TURBO_ROOT$/…` entry to add to
// apps/console/turbo.json. The ledger also fails in the OTHER direction: a `$TURBO_ROOT$` entry
// there that no derived read falls under is stale (it re-runs the whole suite on every edit to a
// file nothing reads), and fails too.
//
// ── MARKDOWN, MEASURED ──────────────────────────────────────────────────────────────────────────
//
// The root's `!**/*.md` / `!**/*.mdx` only ever excludes files INSIDE a package: with turbo 2.11.7 an
// explicit `$TURBO_ROOT$/docs/legal/GDPR_ACCOUNTABILITY.md` (and even `$TURBO_ROOT$/docs/legal/*.md`)
// is hashed whichever side of `$TURBO_EXTENDS$` it is written on, while an explicit in-package
// `README.md` is NOT hashed in either order — the negation wins. The suite reads in-package markdown
// (apps/console/README.md via scripts/check-route-states.mjs, docs/ui-conformance/*.md via
// scripts/audit-report.mjs), so apps/console/turbo.json does not extend the root's test inputs and
// carries no markdown negation; the root keeps it for every other package. Should the negation come
// back, an in-package markdown read cannot be fixed with an input line at all, and this guard says so.
//
// ── BOUNDARY — WHAT THIS CANNOT SEE ─────────────────────────────────────────────────────────────
//
//   * A path built from a value the evaluator cannot fold — a parameter, a loop variable, a
//     function's return value other than a local single-expression helper's, a path walked up to
//     at runtime (`consoleRoot()`, `repoRoot()` loops). Joined onto an anchor, these are COUNTED
//     and printed as "dynamic" (`--verbose` lists them), never checked. A root-anchored join with
//     a part that will not fold (`resolve(REPO_ROOT, file)`) is in that class unless a path
//     literal in scope supplies the file (see READS).
//   * A file read by a subprocess the test spawns, or by a module reached through a bare package
//     specifier (`next`, `@repo/ui`): node_modules is keyed by the lockfile and workspace
//     packages by their own task hash, so neither needs a line here.
//   * A path that does not exist on disk (a fixture a test writes, an `existsSync` probe) — there is
//     nothing to hash yet.
//   * Non-test files of apps/console that no test imports.
//
// It fails CLOSED when it derives no out-of-package read at all, or cannot read turbo's answer:
// either the suite stopped reading outside files (then this guard and the entries are both dead
// and want deleting together) or the evaluator rotted, and both need a human.
//
// Cost of the fix it asks for: every declared input re-runs the WHOLE console `test` task when it
// changes, not just the one test that reads it. Measured over the 2,184 commits on dev in the 90
// days to 2026-10-07: 80 touched a declared input and nothing else in console#test's key — those are
// the runs the cache used to replay, now ~7 min each of the "Unit tests" step. `--force` for a
// parity subset would pay its share of that on every CI run instead, including the many that change
// nothing it reads.
//
//   node scripts/check-console-test-inputs.mjs              # the repo
//   node scripts/check-console-test-inputs.mjs --verbose    # ...and list the dynamic reads
//   node scripts/check-console-test-inputs.mjs --self-test  # the evaluator and both directions

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require_ = createRequire(import.meta.url);
const ts = require_("typescript");

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONSOLE = path.join(REPO, "apps", "console");
const CONSOLE_TURBO = path.join(CONSOLE, "turbo.json");
const TASK = "console#test";

/** The glob marker an unfoldable template substitution becomes (one path segment, no `/`). */
const STAR = "\u0000";
/** The value of anything the evaluator cannot fold. */
const UNKNOWN = Symbol("unknown");

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const PATH_MODULES = new Set(["path", "node:path", "path/posix", "node:path/posix"]);
const URL_MODULES = new Set(["url", "node:url"]);
/** `fs` functions whose first argument names a file or directory that is READ. */
const FS_READS = new Set([
	"readFileSync", "readFile", "readdirSync", "readdir", "existsSync", "statSync", "stat",
	"lstatSync", "lstat", "createReadStream", "accessSync", "access", "opendirSync", "opendir",
]);
const PATH_FNS = new Set(["join", "resolve", "dirname", "normalize"]);
const SOURCE_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".jsx"];

// ── the evaluator ─────────────────────────────────────────────────────────────────────────────

/** A string value: `anchored` when it names a location (derived from an anchor), not a fragment. */
function str(v, anchored) {
	return { t: "str", v, anchored };
}

/**
 * The import bindings of a module that matter here: which local names are `path`, `fs` and
 * `fileURLToPath`, as namespaces or as named functions. Bound from the import, never by spelling,
 * so `Promise.resolve` and `array.join` are not mistaken for path functions.
 */
function importBindings(sf) {
	const b = { pathNs: new Set(), pathFn: new Map(), fsNs: new Set(), fsFn: new Map(), urlToPath: new Set() };
	for (const st of sf.statements) {
		if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.importClause) continue;
		const mod = st.moduleSpecifier.text;
		const kind = PATH_MODULES.has(mod) ? "path" : FS_MODULES.has(mod) ? "fs" : URL_MODULES.has(mod) ? "url" : null;
		if (!kind) continue;
		const { name, namedBindings } = st.importClause;
		if (name && kind !== "url") (kind === "path" ? b.pathNs : b.fsNs).add(name.text);
		if (namedBindings && ts.isNamespaceImport(namedBindings) && kind !== "url") {
			(kind === "path" ? b.pathNs : b.fsNs).add(namedBindings.name.text);
		}
		if (namedBindings && ts.isNamedImports(namedBindings)) {
			for (const el of namedBindings.elements) {
				const imported = (el.propertyName ?? el.name).text;
				const local = el.name.text;
				if (kind === "path" && PATH_FNS.has(imported)) b.pathFn.set(local, imported);
				if (kind === "path" && imported === "posix") b.pathNs.add(local);
				if (kind === "fs" && FS_READS.has(imported)) b.fsFn.set(local, imported);
				if (kind === "url" && imported === "fileURLToPath") b.urlToPath.add(local);
			}
		}
	}
	return b;
}

/**
 * Every `const`/`let`/`var` and function declaration in the module, by name, scope-blind. A name
 * declared more than once is ambiguous and evaluates to UNKNOWN rather than to a guess.
 */
function declarations(sf) {
	const decls = new Map();
	/** Record one binding, poisoning a name seen twice. */
	const add = (name, node) => decls.set(name, decls.has(name) ? null : node);
	/** Walk the whole tree for declarations. */
	const visit = (n) => {
		if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) add(n.name.text, n.initializer ?? null);
		else if (ts.isFunctionDeclaration(n) && n.name) add(n.name.text, n);
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return decls;
}

/** The single expression a function returns, or null when its body is anything more. */
function returnedExpression(fn) {
	if (!fn.body) return null;
	if (!ts.isBlock(fn.body)) return fn.body;
	const [only] = fn.body.statements;
	return fn.body.statements.length === 1 && ts.isReturnStatement(only) && only.expression ? only.expression : null;
}

/** Strip the wrappers that do not change a value: parens, `as`, `satisfies`, `!`. */
function unwrap(n) {
	while (
		ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) ||
		ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n)
	) {
		n = n.expression;
	}
	return n;
}

/** `import.meta.<prop>`, or null. */
function importMetaProp(n) {
	if (ts.isPropertyAccessExpression(n) && ts.isMetaProperty(n.expression) && n.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
		return n.name.text;
	}
	return null;
}

/** The module's evaluation context: its file, bindings, declarations, and the cwd vitest runs in. */
function context(file, sf) {
	return { file, dir: path.dirname(file), sf, b: importBindings(sf), decls: declarations(sf) };
}

/** Which path function a call invokes (`join` for `path.join`, `posix.join`, a named import), or null. */
function pathFnOf(ctx, callee) {
	if (ts.isIdentifier(callee)) return ctx.b.pathFn.get(callee.text) ?? null;
	if (ts.isPropertyAccessExpression(callee) && PATH_FNS.has(callee.name.text)) {
		const obj = callee.expression;
		if (ts.isIdentifier(obj) && ctx.b.pathNs.has(obj.text)) return callee.name.text;
		if (ts.isPropertyAccessExpression(obj) && obj.name.text === "posix" && ts.isIdentifier(obj.expression) && ctx.b.pathNs.has(obj.expression.text)) {
			return callee.name.text;
		}
	}
	return null;
}

/** True when `name` is bound to a function declared in this module (a helper the evaluator can follow). */
function isLocalFn(ctx, name) {
	const d = ctx.decls.get(name);
	return Boolean(d) && (ts.isFunctionDeclaration(d) || ts.isArrowFunction(d) || ts.isFunctionExpression(d));
}

/** Which `fs` read a call invokes (`readFileSync` for `fs.readFileSync` or a named import), or null. */
function fsReadOf(ctx, callee) {
	if (ts.isIdentifier(callee)) return ctx.b.fsFn.get(callee.text) ?? null;
	if (ts.isPropertyAccessExpression(callee) && FS_READS.has(callee.name.text)) {
		const obj = callee.expression;
		if (ts.isIdentifier(obj) && ctx.b.fsNs.has(obj.text)) return callee.name.text;
		if (ts.isPropertyAccessExpression(obj) && obj.name.text === "promises" && ts.isIdentifier(obj.expression) && ctx.b.fsNs.has(obj.expression.text)) {
			return callee.name.text;
		}
	}
	return null;
}

/**
 * Fold an expression to a value: a string (anchored or a fragment), a file URL, an array, a local
 * function, or UNKNOWN. `env` binds the parameters of a helper being followed; `depth` bounds it.
 */
function evaluate(ctx, node, env = new Map(), depth = 0) {
	if (!node || depth > 24) return UNKNOWN;
	const n = unwrap(node);
	if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return str(n.text, false);
	if (ts.isTemplateExpression(n)) {
		let v = n.head.text;
		let anchored = false;
		for (const span of n.templateSpans) {
			const part = evaluate(ctx, span.expression, env, depth + 1);
			if (part !== UNKNOWN && part.t === "str") {
				v += part.v;
				anchored ||= part.anchored;
			} else v += STAR;
			v += span.literal.text;
		}
		return str(v, anchored);
	}
	if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
		const l = evaluate(ctx, n.left, env, depth + 1);
		const r = evaluate(ctx, n.right, env, depth + 1);
		if (l === UNKNOWN || r === UNKNOWN || l.t !== "str" || r.t !== "str") return UNKNOWN;
		return str(l.v + r.v, l.anchored || r.anchored);
	}
	if (ts.isArrayLiteralExpression(n)) {
		return { t: "arr", items: n.elements.map((e) => evaluate(ctx, e, env, depth + 1)) };
	}
	if (ts.isIdentifier(n)) {
		if (env.has(n.text)) return env.get(n.text);
		if (n.text === "__dirname") return str(ctx.dir, true);
		if (n.text === "__filename") return str(ctx.file, true);
		const decl = ctx.decls.get(n.text);
		if (!decl) return UNKNOWN;
		if (ts.isFunctionDeclaration(decl) || ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) {
			return { t: "fn", node: decl };
		}
		// A followed helper's parameters shadow nothing at module scope, so evaluate the binding fresh.
		return evaluate(ctx, decl, new Map(), depth + 1);
	}
	if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return { t: "fn", node: n };
	const meta = importMetaProp(n);
	if (meta === "url") return { t: "url", v: ctx.file };
	if (meta === "dirname") return str(ctx.dir, true);
	if (meta === "filename") return str(ctx.file, true);
	if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "URL" && n.arguments?.length === 2) {
		const rel = evaluate(ctx, n.arguments[0], env, depth + 1);
		const base = evaluate(ctx, n.arguments[1], env, depth + 1);
		if (rel === UNKNOWN || base === UNKNOWN || rel.t !== "str" || base.t !== "url") return UNKNOWN;
		return { t: "url", v: path.resolve(path.dirname(base.v), rel.v) };
	}
	if (ts.isCallExpression(n)) return evaluateCall(ctx, n, env, depth);
	return UNKNOWN;
}

/** Fold a call: a path function, `fileURLToPath`, `process.cwd()`, or a local helper followed once. */
function evaluateCall(ctx, n, env, depth) {
	const callee = unwrap(n.expression);
	if (
		ts.isPropertyAccessExpression(callee) && callee.name.text === "cwd" &&
		ts.isIdentifier(callee.expression) && callee.expression.text === "process"
	) {
		// turbo runs a package's task with the package as its working directory.
		return str(CONSOLE, true);
	}
	if (ts.isIdentifier(callee) && ctx.b.urlToPath.has(callee.text)) {
		const u = evaluate(ctx, n.arguments[0], env, depth + 1);
		return u !== UNKNOWN && u.t === "url" ? str(u.v, true) : UNKNOWN;
	}
	const args = [];
	for (const a of n.arguments) {
		if (ts.isSpreadElement(a)) {
			const spread = evaluate(ctx, a.expression, env, depth + 1);
			if (spread === UNKNOWN || spread.t !== "arr") return UNKNOWN;
			args.push(...spread.items);
		} else args.push(evaluate(ctx, a, env, depth + 1));
	}
	const pathFn = pathFnOf(ctx, callee);
	if (pathFn) {
		if ((pathFn === "join" || pathFn === "resolve") && args.length > 1) {
			// `join(FIXTURES, name)`: a known anchored directory, then segments that do not fold. The
			// read is SOME file in that directory, so it becomes `<dir>/*` — but only at a read, and
			// never when the directory is a root (`resolve(REPO_ROOT, file)` is any file at all).
			const k = args.findIndex((a) => a === UNKNOWN || a.t !== "str");
			if (k > 0 && args.slice(k).every((a) => a === UNKNOWN || a.t !== "str") && args.slice(0, k).some((a) => a.anchored)) {
				const dir = pathFn === "join" ? path.join(...args.slice(0, k).map((a) => a.v)) : path.resolve(CONSOLE, ...args.slice(0, k).map((a) => a.v));
				return { t: "str", v: path.join(dir, STAR), anchored: true, partial: dir };
			}
		}
		if (args.some((a) => a === UNKNOWN || a.t !== "str" || a.partial)) return UNKNOWN;
		const vs = args.map((a) => a.v);
		const anchored = args.some((a) => a.anchored);
		if (pathFn === "join") return str(path.join(...vs), anchored);
		if (pathFn === "normalize") return str(path.normalize(vs[0]), anchored);
		if (pathFn === "dirname") return str(path.dirname(vs[0]), anchored);
		// resolve: an argument list with no absolute member resolves against cwd — apps/console.
		return str(path.resolve(CONSOLE, ...vs), true);
	}
	if (ts.isIdentifier(callee)) {
		const fn = env.has(callee.text) ? env.get(callee.text) : evaluate(ctx, callee, env, depth + 1);
		if (fn === UNKNOWN || fn.t !== "fn") return UNKNOWN;
		const body = returnedExpression(fn.node);
		if (!body) return UNKNOWN;
		const inner = new Map();
		fn.node.parameters.forEach((p, i) => {
			if (!ts.isIdentifier(p.name)) return;
			inner.set(p.name.text, p.dotDotDotToken ? { t: "arr", items: args.slice(i) } : (args[i] ?? UNKNOWN));
		});
		return evaluate(ctx, body, inner, depth + 1);
	}
	return UNKNOWN;
}

// ── the module walk ───────────────────────────────────────────────────────────────────────────

/** Resolve an import specifier from `fromFile` to a file on disk, or null for a bare package. */
function resolveSpecifier(spec, fromFile) {
	let base;
	if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(fromFile), spec);
	else if (spec.startsWith("@/")) base = path.join(CONSOLE, spec.slice(2));
	else return null;
	const candidates = [
		base,
		...SOURCE_EXT.map((e) => base + e),
		base + ".json",
		...SOURCE_EXT.map((e) => path.join(base, "index" + e)),
	];
	// ESM-style TypeScript: `./x.js` names `./x.ts`.
	if (/\.(m|c)?js$/.test(base)) candidates.push(base.replace(/\.(m|c)?js$/, ".ts"), base.replace(/\.(m|c)?js$/, ".tsx"));
	for (const c of candidates) {
		try {
			if (fs.statSync(c).isFile()) return c;
		} catch {
			// not this one
		}
	}
	return null;
}

/** The import specifiers a module loads: static, re-export, dynamic, require, and vitest's module APIs. */
function specifiers(sf) {
	const out = [];
	/** Collect string-literal module specifiers anywhere in the tree. */
	const visit = (n) => {
		if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
			out.push(n.moduleSpecifier.text);
		} else if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteralLike(n.arguments[0])) {
			const c = n.expression;
			const isImport = c.kind === ts.SyntaxKind.ImportKeyword;
			const isRequire = ts.isIdentifier(c) && c.text === "require";
			const isVi = ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "vi" &&
				["mock", "doMock", "importActual", "importMock"].includes(c.name.text);
			if (isImport || isRequire || isVi) out.push(n.arguments[0].text);
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return out;
}

/** Parse a module, choosing the script kind from its extension. */
function parse(file, text) {
	const ext = path.extname(file);
	const kind = ext === ".tsx" ? ts.ScriptKind.TSX : ext === ".jsx" ? ts.ScriptKind.JSX
		: [".js", ".mjs", ".cjs"].includes(ext) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
	return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/** True when `abs` is inside `dir`. */
function isUnder(abs, dir) {
	const rel = path.relative(dir, abs);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The anchored path expressions of one module, as { abs, line, dynamic } — `abs` absolute (and
 * possibly carrying STAR), or `dynamic` when an anchored expression could not be folded.
 */
export function pathsIn(file, text) {
	const sf = parse(file, text);
	const ctx = context(file, sf);
	const out = [];
	/** Record a folded value at a node. */
	const record = (node, v, viaSink) => {
		const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
		if (v === UNKNOWN) {
			if (viaSink) out.push({ abs: null, line, dynamic: true });
			return;
		}
		if (v.partial) {
			const root = v.partial === REPO || v.partial === CONSOLE || !isUnder(v.partial, REPO);
			if (viaSink) out.push(root ? { abs: null, line, dynamic: true, rootDynamic: true } : { abs: v.v, line, sink: true });
			return;
		}
		if (v.t === "url") out.push({ abs: v.v, line, sink: viaSink });
		else if (v.t === "str" && v.anchored) out.push({ abs: v.v, line, sink: viaSink });
		else if (v.t === "str" && viaSink && !path.isAbsolute(v.v)) out.push({ abs: path.resolve(CONSOLE, v.v), line, sink: true });
	};
	/** Visit every path-building expression and every fs read. */
	const visit = (n) => {
		if (ts.isCallExpression(n)) {
			const callee = unwrap(n.expression);
			if (fsReadOf(ctx, callee) && n.arguments.length > 0) {
				record(n, evaluate(ctx, n.arguments[0], paramsInScope(n)), true);
			} else if (pathFnOf(ctx, callee) || (ts.isIdentifier(callee) && (ctx.b.urlToPath.has(callee.text) || isLocalFn(ctx, callee.text)))) {
				const v = evaluate(ctx, n, paramsInScope(n));
				// An anchored expression that would not fold is reported only when it reaches a read.
				if (v !== UNKNOWN) record(n, v, false);
			}
		} else if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "URL") {
			const v = evaluate(ctx, n, paramsInScope(n));
			if (v !== UNKNOWN) record(n, v, false);
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return out;
}

/**
 * The parameters of every function enclosing `node`, bound to UNKNOWN, so a read inside a helper
 * never folds its parameter to an unrelated same-named `const` elsewhere in the module.
 */
function paramsInScope(node) {
	const env = new Map();
	for (let n = node.parent; n; n = n.parent) {
		if (ts.isFunctionLike(n)) {
			for (const p of n.parameters ?? []) if (ts.isIdentifier(p.name) && !env.has(p.name.text)) env.set(p.name.text, UNKNOWN);
		}
	}
	return env;
}

/**
 * String literals that spell the repo-relative path of a tracked file outside apps/console, as
 * { rel, line }. These catch reads whose path is data — an `it.each` table row, a lib constant a test
 * hands to `readFileSync` — where the read site itself joins a parameter and cannot be folded.
 */
export function pathLiterals(file, text, outsideTracked) {
	const sf = parse(file, text);
	const out = [];
	/** Collect matching literals. */
	const visit = (n) => {
		if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && outsideTracked.has(n.text)) {
			out.push({ rel: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
	return out;
}

/** Every git-tracked file, repo-relative. Turbo hashes the tracked (and untracked-unignored) tree. */
function trackedFiles() {
	return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28 })
		.split("\0").filter(Boolean);
}

/** A STAR-bearing absolute path as a regex over repo-relative paths. */
function starRegex(rel) {
	const esc = rel.split(STAR).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return new RegExp("^" + esc.join("[^/]*") + "$");
}

/** The test entry files vitest's default (`turbo run test`) config runs, and its setupFiles. */
function testEntries() {
	const out = execFileSync("pnpm", ["exec", "vitest", "list", "--filesOnly", "--json"], {
		cwd: CONSOLE, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"],
	});
	const listed = JSON.parse(out.slice(out.indexOf("["))).map((e) => e.file);
	const cfg = parse(path.join(CONSOLE, "vitest.config.ts"), fs.readFileSync(path.join(CONSOLE, "vitest.config.ts"), "utf8"));
	/** Find the setupFiles array literal. */
	const visit = (n) => {
		if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "setupFiles" && ts.isArrayLiteralExpression(n.initializer)) {
			for (const e of n.initializer.elements) if (ts.isStringLiteral(e)) listed.push(path.resolve(CONSOLE, e.text));
		}
		ts.forEachChild(n, visit);
	};
	visit(cfg);
	return listed;
}

/**
 * Walk from the entries through every relative / `@/` import, and return each read with the test
 * modules that reach it: { reads: Map<repoRel, Set<"file:line">>, dynamic: [...], modules: n }.
 */
export function deriveReads(entries, tracked) {
	const trackedSet = new Set(tracked);
	const outsideTracked = new Set(tracked.filter((t) => t.includes("/") && !isUnder(path.join(REPO, t), CONSOLE)));
	const entrySet = new Set(entries);
	const reads = new Map();
	const dynamic = [];
	/** file -> { imports: absolute targets, paths, literals, reads: has an fs read, rootDynamic } */
	const modules = new Map();
	const queue = [...entries];
	/** Record one read of a repo-relative path from a site. */
	const add = (rel, site) => {
		if (!reads.has(rel)) reads.set(rel, new Set());
		reads.get(rel).add(site);
	};
	while (queue.length > 0) {
		const file = queue.shift();
		if (modules.has(file)) continue;
		const mod = { imports: [], paths: [], literals: [], reads: false, rootDynamic: false };
		modules.set(file, mod);
		if (file.endsWith(".json")) continue;
		let text;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const sf = parse(file, text);
		for (const spec of specifiers(sf)) {
			const target = resolveSpecifier(spec, file);
			if (!target || target.includes(`${path.sep}node_modules${path.sep}`)) continue;
			mod.imports.push(target);
			if (SOURCE_EXT.includes(path.extname(target)) || target.endsWith(".json")) queue.push(target);
		}
		mod.paths = pathsIn(file, text);
		mod.reads = mod.paths.some((p) => p.sink || p.dynamic);
		mod.rootDynamic = mod.paths.some((p) => p.rootDynamic);
		mod.literals = pathLiterals(file, text, outsideTracked);
	}

	// A path literal counts where a read can consume it: in a module that reads files itself, or in
	// a module a TEST imports directly when that test reads `resolve(REPO_ROOT, <data>)` — the path
	// came from the imported data (`TEMPLATE_DEFAULT_NODE[...].source.file`, an `it.each` row).
	const literalScope = new Set();
	for (const [file, mod] of modules) {
		if (mod.reads) literalScope.add(file);
		if (entrySet.has(file) && mod.rootDynamic) for (const t of mod.imports) literalScope.add(t);
	}

	for (const [file, mod] of modules) {
		const siteFile = path.relative(REPO, file);
		for (const target of mod.imports) {
			if (!isUnder(target, CONSOLE)) add(path.relative(REPO, target), `${siteFile} (import)`);
		}
		if (literalScope.has(file)) {
			for (const lit of mod.literals) add(lit.rel, `${siteFile}:${lit.line} (path literal)`);
		}
		for (const p of mod.paths) {
			const site = `${siteFile}:${p.line}`;
			if (p.dynamic) {
				dynamic.push(site);
				continue;
			}
			if (!isUnder(p.abs, REPO)) continue;
			const rel = path.relative(REPO, p.abs);
			if (rel.includes(STAR)) {
				const re = starRegex(rel);
				for (const t of tracked) if (re.test(t)) add(t, site);
			} else if (trackedSet.has(rel)) add(rel, site);
			else if (p.sink && rel !== "" && !rel.startsWith("..")) {
				// A directory handed to a read (`readdirSync`): its LISTING is what the test sees, and
				// the listing changes exactly when a file under it is added or removed — which only a
				// glob over the whole directory can put in the key. So every file under it is a read.
				for (const t of tracked) if (t.startsWith(rel + "/")) add(t, `${site} (directory)`);
			}
		}
	}
	return { reads, dynamic, modules: modules.size };
}

/** turbo's hashed inputs for console#test and everything it depends on, as repo-relative paths. */
export function hashedInputs(dry) {
	const byId = new Map(dry.tasks.map((t) => [t.taskId, t]));
	if (!byId.has(TASK)) throw new Error(`turbo's dry run has no ${TASK} task`);
	const out = new Set();
	const stack = [TASK];
	const visited = new Set();
	while (stack.length > 0) {
		const id = stack.pop();
		if (visited.has(id)) continue;
		visited.add(id);
		const t = byId.get(id);
		if (!t) continue;
		for (const k of Object.keys(t.inputs ?? {})) out.add(path.relative(REPO, path.resolve(REPO, t.directory, k)));
		stack.push(...(t.dependencies ?? []));
	}
	return out;
}

/** The `$TURBO_ROOT$/…` entries apps/console/turbo.json adds to the test task (JSONC). */
export function declaredRootInputs(jsoncText) {
	const out = [];
	for (const m of jsoncText.matchAll(/"\$TURBO_ROOT\$\/([^"]+)"/g)) out.push(m[1]);
	return out;
}

/** A turbo input glob (repo-relative) as a regex: `**` crosses directories, `*` does not. */
function globRegex(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += ".*";
			i++;
			if (glob[i + 1] === "/") i++;
		} else if (c === "*") re += "[^/]*";
		else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp("^" + re + "$");
}

/**
 * The verdict: reads turbo does not hash, and declared root inputs no read falls under.
 * Pure, so the self-test can drive it with a mutated hashed set.
 */
export function verdict({ reads, hashed, declared }) {
	const missing = [];
	for (const [rel, sites] of reads) if (!hashed.has(rel)) missing.push({ rel, sites: [...sites] });
	const stale = declared.filter((g) => {
		const re = globRegex(g);
		return ![...reads.keys()].some((r) => re.test(r));
	});
	return { missing: missing.sort((a, b) => a.rel.localeCompare(b.rel)), stale };
}

/** Run turbo's dry run with the repo's own (lockfile-pinned) binary and parse it. */
function turboDry() {
	const out = execFileSync("pnpm", ["exec", "turbo", "run", "test", "--filter=console", "--dry=json"], {
		cwd: REPO, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(out.slice(out.indexOf("{")));
}

/** Print the verdict and return the exit code. */
function report({ reads, dynamic, modules }, { missing, stale }) {
	const outside = [...reads.keys()].filter((r) => !isUnder(path.join(REPO, r), CONSOLE));
	console.log(
		`console test inputs: ${modules} modules walked from the vitest suite; ${reads.size} repo files read ` +
		`(${outside.length} outside apps/console); ${dynamic.length} anchored reads too dynamic to fold (not checked).`,
	);
	if (process.argv.includes("--verbose")) for (const d of dynamic) console.log(`  dynamic: ${d}`);
	if (outside.length === 0) {
		console.error(
			"::error::derived NO out-of-package read. Either the suite stopped reading outside files (then delete this guard " +
			"and the $TURBO_ROOT$ entries in apps/console/turbo.json together) or the evaluator rotted. Both need a human.",
		);
		return 1;
	}
	let code = 0;
	for (const { rel, sites } of missing) {
		code = 1;
		const inPkgMd = isUnder(path.join(REPO, rel), CONSOLE) && /\.mdx?$/.test(rel);
		const fix = inPkgMd
			? "it is IN-package markdown, which the root `!**/*.md(x)` excludes and no input line can re-include (measured) — move the data out of a .md, or read it from outside the package"
			: isUnder(path.join(REPO, rel), CONSOLE)
				? "it is in-package but not hashed (gitignored?)"
				: `add "$TURBO_ROOT$/${rel}" to test.inputs in apps/console/turbo.json`;
		console.error(`::error::${rel} is read by a console test but is not in ${TASK}'s turbo inputs — ${fix}.`);
		for (const s of sites.slice(0, 5)) console.error(`    read at ${s}`);
	}
	for (const g of stale) {
		code = 1;
		console.error(`::error::apps/console/turbo.json declares "$TURBO_ROOT$/${g}" but no console test read falls under it — it is stale; delete it.`);
	}
	if (code === 0) console.log(`ok: every one of them is in ${TASK}'s cache key.`);
	return code;
}

/** The repo check. */
function main() {
	let dry;
	try {
		dry = turboDry();
	} catch (e) {
		console.error(`::error::could not read turbo's dry run for ${TASK}: ${e.message}`);
		return 1;
	}
	const tracked = trackedFiles();
	const derived = deriveReads(testEntries(), tracked);
	const v = verdict({ reads: derived.reads, hashed: hashedInputs(dry), declared: declaredRootInputs(fs.readFileSync(CONSOLE_TURBO, "utf8")) });
	return report(derived, v);
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

/** Each anchor form folds to the path it names; each unfoldable form does not. Then both directions. */
function selfTest() {
	let fails = 0;
	/** One assertion. */
	const check = (name, ok, detail = "") => {
		console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
		if (!ok) fails++;
	};
	const file = path.join(CONSOLE, "tests", "lib", "x", "probe.test.ts");
	const src = `
import { readFileSync, readdirSync } from "node:fs";
import path, { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");
const A = readFileSync(resolve(ROOT, "packages/core/catalog/catalog.json"), "utf8");
const B = readFileSync(join(process.cwd(), "..", "..", "docs/legal/GDPR_ACCOUNTABILITY.md"), "utf8");
const repo = (...p: string[]) => resolve(__dirname, "../../../../..", ...p);
const C = readFileSync(repo("infra/templates/argocd/external-dns.yaml"), "utf8");
const D = readFileSync("../../infra/offer-exclusions.yaml", "utf8");
const fixtureFor = (cloud: string) => join(__dirname, \`../../../../../test/e2e/fixtures/t2_config_snapshot.\${cloud}.json\`);
for (const cloud of ["aws"]) readFileSync(fixtureFor(cloud), "utf8");
const E = readFileSync(new URL("../../../../../deploy/status/config.yaml", import.meta.url), "utf8");
const F = path.posix.join(import.meta.dirname, "../../../../../packages/brand/src/tokens.css");
const notAPath = Promise.resolve("x");
const alsoNot = ["a", "b"].join("/");
function walk(dir: string) { return readdirSync(join(ROOT, dir)); }
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/core/api/testdata");
function loadFixture(name: string) { return readFileSync(join(FIXTURES, name), "utf8"); }
const name = "shadowed.json";
const RUNNERS = join(__dirname, "../../../../..", "infra/templates/runner");
readdirSync(RUNNERS);
`;
	const got = pathsIn(file, src);
	const rel = (p) => path.relative(REPO, p.abs);
	const folded = got.filter((p) => p.abs).map(rel);
	for (const want of [
		"packages/core/catalog/catalog.json",
		"docs/legal/GDPR_ACCOUNTABILITY.md",
		"infra/templates/argocd/external-dns.yaml",
		"infra/offer-exclusions.yaml",
		`test/e2e/fixtures/t2_config_snapshot.${STAR}.json`,
		"deploy/status/config.yaml",
		"packages/brand/src/tokens.css",
	]) {
		check(`folds ${want.replace(STAR, "*")}`, folded.includes(want), JSON.stringify(folded.map((f) => f.replace(STAR, "*"))));
	}
	check(
		"a parameter joined onto a known non-root directory at a read is `<dir>/*`, and does not fold to a same-named const",
		folded.includes(`packages/core/api/testdata/${STAR}`) && !folded.includes("packages/core/api/testdata/shadowed.json"),
		JSON.stringify(folded.map((f) => f.replace(STAR, "*"))),
	);
	check("a directory handed to readdirSync is a sink read", got.some((p) => p.sink && rel(p) === "infra/templates/runner"));
	check("Promise.resolve / Array#join are not path functions", !folded.some((f) => f === "x" || f.endsWith("a/b")), JSON.stringify(folded));
	check("a parameter joined onto an anchor at a read is DYNAMIC, not dropped", got.some((p) => p.dynamic));

	// The real repo, both directions. MUTATE ONCE: drop one hashed outside file from turbo's answer.
	const dry = turboDry();
	const tracked = trackedFiles();
	const derived = deriveReads(testEntries(), tracked);
	const hashed = hashedInputs(dry);
	const declared = declaredRootInputs(fs.readFileSync(CONSOLE_TURBO, "utf8"));
	const clean = verdict({ reads: derived.reads, hashed, declared });
	check("the repo as it stands is clean", clean.missing.length === 0 && clean.stale.length === 0, JSON.stringify(clean));
	const victim = "packages/core/catalog/catalog.json";
	check(`the walk derives ${victim} from the suite`, derived.reads.has(victim));
	const mutated = new Set(hashed);
	mutated.delete(victim);
	const red = verdict({ reads: derived.reads, hashed: mutated, declared });
	check("an outside read turbo does not hash FAILS", red.missing.some((m) => m.rel === victim), JSON.stringify(red.missing));
	const staleRed = verdict({ reads: derived.reads, hashed, declared: [...declared, "infra/nothing-reads-this.yaml"] });
	check("a declared input nothing reads FAILS (stale)", staleRed.stale.includes("infra/nothing-reads-this.yaml"));
	// Muted: the ::error:: line it prints is the EXPECTED outcome here and must not annotate the run.
	const [log, err] = [console.log, console.error];
	console.log = console.error = () => {};
	let silent;
	try {
		silent = report({ reads: new Map(), dynamic: [], modules: 0 }, { missing: [], stale: [] });
	} finally {
		[console.log, console.error] = [log, err];
	}
	check("zero outside reads fails CLOSED", silent === 1);

	if (fails > 0) {
		console.error(`\ncheck-console-test-inputs self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

const isEntry = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntry && process.argv.includes("--self-test")) selfTest();
else if (isEntry) process.exit(main());
