// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Action-boundary guard. `"use server"` is a FILE-level directive: Next.js compiles EVERY export
// of such a file into a POST-addressable Server Action with a stable action id. An export that
// never establishes who is calling is therefore an unauthenticated endpoint reachable by anyone
// who can reach the app — regardless of who its intended in-process caller is.
//
// That is the shape this guard refuses, and it refuses it PER EXPORT. The history is why:
//   - #2838 moved three runner-callback finalizers to lib/ (lib/jobs/finalize-deployment.ts,
//     lib/jobs/finalize-build.ts, lib/probes/persistence.ts). One of them, enqueueDeployAfterBuild,
//     INSERTED a DEPLOY job — real cloud infrastructure — from a bare job UUID.
//   - The guard that followed was FILE-level: a file passed when ANY export resolved an actor. So a
//     MIXED file — user-facing actions that authorize, beside service-role exports that do not —
//     passed. #5218 found applyPromotionApproval in one: anyone could record an approval as ANY user
//     id and enqueue a DEPLOY. #5219 moved the rest (recordEnvironmentCost, recordDriftPosture,
//     recordFabricDriftPosture, finalizeChartScan, finalizeIacScan, maybeAutoHeal, …) to lib/.
//
// ── WHAT "ESTABLISHES AN ACTOR" MEANS HERE ────────────────────────────────────────────────────
//
// An export passes when its body — followed through every function it calls that resolves to
// console source, same-file or imported, transitively — reaches a READ OF THE SESSION: a call to
// `auth.api.getSession(...)` where `auth` is the Better Auth instance exported by lib/auth/index.ts.
// That is the leaf under currentActor(), authorize(), authorizeQuiet(), requireOwner(), getOwner(),
// getOwnerScope() and every require*/assert* wrapper built on them, so none of those is listed by
// name: a list of names is a hand-written domain that decays, and a local helper that happened to
// be CALLED `authorize` would satisfy it. The leaf is matched by where `auth` is IMPORTED FROM, not
// by what it is called.
//
// ── WHAT THIS GUARD DOES NOT PROVE, stated so nobody reads a pass as more than it is ─────────────
//
//   - PRESENCE, not order or outcome. It proves the call graph REACHES a session read, not that the
//     read happens before the first write, nor that a null answer (getOwner() returns null rather
//     than throwing) is acted on, nor that the call sits on every branch.
//   - AUTHENTICATION, not AUTHORIZATION. Resolving the caller is the line this holds; whether the
//     export then asks the PDP for the RIGHT permission on the RIGHT resource is review's job, and
//     check-authz-scope.mjs's for the `.eq(user_id)` shape. An export that resolves an actor and
//     then ignores it passes.
//   - Calls it cannot resolve are NOT followed: a package import (`@repo/*`, `drizzle-orm`), a
//     method on an object, a dynamic import, a function passed as a value. A gate reached only that
//     way reads as absent — the guard errs toward a finding, never toward a pass.
//   - It reads "use server" files anywhere under apps/console (app/, lib/, components/, …), which
//     is where Next reads them. A `"use server"` INSIDE a function body (an inline action) is not a
//     file directive and is not scanned; the console has none today.
//
// ── THE EXCEPTION LEDGER ──────────────────────────────────────────────────────────────────────
//
// A genuinely pre-auth export (the sign-in code request, public price lists) carries
// `// action-boundary-ok: <reason>` in ITS OWN leading comment — the JSDoc or line comments
// directly above the export. The ledger lives next to the code it excuses and fails in BOTH
// directions:
//   - an export with no session read and no marker fails (the defect);
//   - a marker on an export that DOES reach a session read fails (a stale excuse, which would
//     otherwise silently cover the next regression in that export);
//   - a marker anywhere else in a "use server" file — a file header, a non-exported helper — fails
//     (an orphan, which is how the old file-level marker excused every export at once).
// The reason is REQUIRED on the marker's own line: `.` excludes newlines, so a bare marker cannot
// borrow the next line's text.
//
// HOW IT KNOWS IT LOOKED: a missing root, a tree with no "use server" file, or a file that fails
// to parse is refused, and every run first fires the probes below through the same analyser — a
// fixture that must pass and fixtures that must fail — so an analyser that stopped matching fails
// before it can print OK over nothing. `--self-test` runs the probes alone.
//
// It PARSES with the console's own `typescript`, and refuses (exit 2) where that is not installed
// rather than falling back to a weaker read.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const CONSOLE = path.resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".next", "coverage", "tests", "scripts", "public", ".turbo"]);
/** The Better Auth instance whose `api.getSession` is the leaf every gate reaches. */
const AUTH_MODULE = path.join(CONSOLE, "lib/auth/index.ts");
const AUTH_EXPORT = "auth";

/** A real top-of-file directive, not the string mentioned inside a comment. */
const USE_SERVER = /^\s*["']use server["'];?\s*$/m;
/** The exception marker; the reason must be on the same line. */
const ALLOW = /action-boundary-ok:.*\S/;
/** Any mention of the marker at all, reasoned or not — used to find orphans and bare markers. */
const ALLOW_ANY = /action-boundary-ok/;

/**
 * Load the console's own `typescript`, refusing with the fix when it is not installed.
 *
 * @returns {typeof import("typescript")}
 */
function loadTypescript() {
	try {
		return createRequire(path.join(CONSOLE, "package.json"))("typescript");
	} catch {
		process.stderr.write(
			"check-action-boundary: cannot load `typescript` from apps/console. This check PARSES the console and will not\n" +
				"fall back to a weaker read. Run it where dependencies are installed (CI, or `pnpm env:check`), or install\n" +
				"with `pnpm install --frozen-lockfile`.\n",
		);
		process.exit(2);
	}
}

const ts = loadTypescript();

// ── the analyser ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an analyser over a virtual or real file system. The self-test hands it an in-memory map so
 * every probe runs through exactly the code the real scan does.
 *
 * @param {(file: string) => string | null} read returns a file's text, or null when absent
 * @param {string} authModule absolute path of the module exporting the Better Auth instance
 * @param {string} root the directory `@/` resolves against
 */
function createAnalyser(read, authModule, root) {
	/** @type {Map<string, ReturnType<typeof parse> | null>} */
	const parsed = new Map();
	/** @type {Map<string, boolean>} */
	const memo = new Map();

	/**
	 * Parse one file into its local functions, its imports and its exports.
	 *
	 * @param {string} file
	 */
	function parse(file) {
		const text = read(file);
		if (text === null) return null;
		const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
		const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
		/** @type {Map<string, import("typescript").Node>} local name → function-like node */
		const functions = new Map();
		/** @type {Map<string, { spec: string, name: string }>} local name → import */
		const imports = new Map();
		/** @type {Map<string, string>} exported name → local name */
		const localExports = new Map();
		/** @type {Map<string, { spec: string, name: string }>} exported name → re-export */
		const reExports = new Map();
		/** @type {string[]} */
		const starExports = [];
		/** @type {{ name: string, statement: import("typescript").Node, local: string | null }[]} */
		const exported = [];

		for (const st of sf.statements) {
			const mods = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
			const isExported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
			const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

			if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
				const spec = st.moduleSpecifier.text;
				const clause = st.importClause;
				if (!clause || clause.isTypeOnly) continue;
				if (clause.name) imports.set(clause.name.text, { spec, name: "default" });
				const nb = clause.namedBindings;
				if (nb && ts.isNamedImports(nb)) {
					for (const el of nb.elements) {
						if (el.isTypeOnly) continue;
						imports.set(el.name.text, { spec, name: (el.propertyName ?? el.name).text });
					}
				}
				continue;
			}
			if (ts.isFunctionDeclaration(st) && st.name) {
				functions.set(st.name.text, st);
				if (isExported) {
					const name = isDefault ? "default" : st.name.text;
					localExports.set(name, st.name.text);
					exported.push({ name, statement: st, local: st.name.text });
				}
				continue;
			}
			if (ts.isVariableStatement(st)) {
				for (const d of st.declarationList.declarations) {
					if (!ts.isIdentifier(d.name)) continue;
					const init = d.initializer;
					if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
						functions.set(d.name.text, init);
					}
					if (isExported) {
						localExports.set(d.name.text, d.name.text);
						exported.push({ name: d.name.text, statement: st, local: d.name.text });
					}
				}
				continue;
			}
			if (ts.isExportDeclaration(st)) {
				if (st.isTypeOnly) continue;
				const spec = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
				if (!st.exportClause) {
					if (spec) starExports.push(spec);
					continue;
				}
				if (ts.isNamedExports(st.exportClause)) {
					for (const el of st.exportClause.elements) {
						if (el.isTypeOnly) continue;
						const from = (el.propertyName ?? el.name).text;
						if (spec) reExports.set(el.name.text, { spec, name: from });
						else localExports.set(el.name.text, from);
						exported.push({ name: el.name.text, statement: st, local: spec ? null : from });
					}
				}
				continue;
			}
			if (ts.isExportAssignment(st)) {
				exported.push({ name: "default", statement: st, local: null });
				continue;
			}
			if (isExported && !ts.isInterfaceDeclaration(st) && !ts.isTypeAliasDeclaration(st)) {
				exported.push({ name: `<${ts.SyntaxKind[st.kind]}>`, statement: st, local: null });
			}
		}
		const diagnostics = /** @type {{ parseDiagnostics?: unknown[] }} */ (sf).parseDiagnostics ?? [];
		return { sf, text, functions, imports, localExports, reExports, starExports, exported, diagnostics };
	}

	/**
	 * Parse a file once.
	 *
	 * @param {string} file
	 */
	function get(file) {
		if (!parsed.has(file)) parsed.set(file, parse(file));
		return parsed.get(file) ?? null;
	}

	/**
	 * Resolve an import specifier to a console source file, or null for a package / missing file.
	 *
	 * @param {string} from importing file
	 * @param {string} spec
	 */
	function resolveModule(from, spec) {
		let base;
		if (spec.startsWith("@/")) base = path.join(root, spec.slice(2));
		else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
		else return null;
		for (const cand of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
			if (/\.tsx?$/.test(cand) && read(cand) !== null) return cand;
		}
		return null;
	}

	/**
	 * Find the function node an export name of `file` refers to, following re-exports.
	 *
	 * @param {string} file
	 * @param {string} name
	 * @param {Set<string>} [seen]
	 * @returns {{ file: string, local: string } | null}
	 */
	function resolveExport(file, name, seen = new Set()) {
		const key = `${file}#${name}`;
		if (seen.has(key)) return null;
		seen.add(key);
		const p = get(file);
		if (!p) return null;
		const local = p.localExports.get(name);
		if (local !== undefined) return resolveLocal(file, local, seen);
		const re = p.reExports.get(name);
		if (re) {
			const target = resolveModule(file, re.spec);
			return target ? resolveExport(target, re.name, seen) : null;
		}
		for (const spec of p.starExports) {
			const target = resolveModule(file, spec);
			const hit = target ? resolveExport(target, name, seen) : null;
			if (hit) return hit;
		}
		return null;
	}

	/**
	 * Resolve an identifier as seen from inside `file`: a local function, or an import.
	 *
	 * @param {string} file
	 * @param {string} local
	 * @param {Set<string>} [seen]
	 * @returns {{ file: string, local: string } | null}
	 */
	function resolveLocal(file, local, seen = new Set()) {
		const p = get(file);
		if (!p) return null;
		if (p.functions.has(local)) return { file, local };
		const imp = p.imports.get(local);
		if (imp) {
			const target = resolveModule(file, imp.spec);
			return target ? resolveExport(target, imp.name, seen) : null;
		}
		return null;
	}

	/**
	 * Is `ident`, as seen from `file`, the Better Auth instance exported by the auth module?
	 *
	 * @param {string} file
	 * @param {string} ident
	 */
	function isAuthInstance(file, ident) {
		if (file === authModule) return ident === AUTH_EXPORT;
		const p = get(file);
		const imp = p?.imports.get(ident);
		if (!imp) return false;
		const target = resolveModule(file, imp.spec);
		return target === authModule && imp.name === AUTH_EXPORT;
	}

	/**
	 * Does this call read the session — `<auth>.api.getSession(...)`?
	 *
	 * @param {string} file
	 * @param {import("typescript").CallExpression} call
	 */
	function isSessionRead(file, call) {
		const callee = call.expression;
		if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "getSession") return false;
		const api = callee.expression;
		if (!ts.isPropertyAccessExpression(api) || api.name.text !== "api") return false;
		return ts.isIdentifier(api.expression) && isAuthInstance(file, api.expression.text);
	}

	/**
	 * Does the function `local` of `file` reach a session read, transitively?
	 *
	 * @param {string} file
	 * @param {string} local
	 * @param {Set<string>} stack functions currently being walked (cycle guard)
	 */
	function reaches(file, local, stack) {
		const key = `${file}#${local}`;
		const known = memo.get(key);
		if (known !== undefined) return known;
		if (stack.has(key)) return false;
		stack.add(key);
		const p = get(file);
		const node = p?.functions.get(local);
		const result = node ? nodeReaches(file, node, stack) : false;
		stack.delete(key);
		// Only a positive answer is final: a negative one reached through a cycle may be partial.
		if (result || stack.size === 0) memo.set(key, result);
		return result;
	}

	/**
	 * Does any call under `node` reach a session read?
	 *
	 * @param {string} file
	 * @param {import("typescript").Node} node
	 * @param {Set<string>} stack
	 */
	function nodeReaches(file, node, stack) {
		let found = false;
		/** @param {import("typescript").Node} n */
		const visit = (n) => {
			if (found) return;
			if (ts.isCallExpression(n)) {
				if (isSessionRead(file, n)) {
					found = true;
					return;
				}
				if (ts.isIdentifier(n.expression)) {
					const target = resolveLocal(file, n.expression.text);
					if (target && reaches(target.file, target.local, stack)) {
						found = true;
						return;
					}
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(node);
		return found;
	}

	/**
	 * The comment text directly above a statement (its JSDoc and line comments).
	 *
	 * @param {string} text
	 * @param {import("typescript").Node} statement
	 */
	function leadingComments(text, statement) {
		const ranges = ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? [];
		return ranges.map((r) => text.slice(r.pos, r.end)).join("\n");
	}

	/**
	 * Analyse one "use server" file: every export's verdict, plus any orphan or bare marker.
	 *
	 * @param {string} file
	 * @returns {{ findings: string[], exports: number } | null}
	 */
	function analyse(file) {
		const p = get(file);
		if (!p) return null;
		const findings = [];
		if (p.diagnostics.length > 0) {
			findings.push(`does not parse (${p.diagnostics.length} syntax error(s)) — a partial tree is not a clean one`);
			return { findings, exports: 0 };
		}
		/** @type {Set<number>} character offsets of markers that sit on an export */
		const claimed = new Set();
		let count = 0;
		for (const e of p.exported) {
			count += 1;
			const comments = leadingComments(p.text, e.statement);
			const commentStart = e.statement.getFullStart();
			const marked = ALLOW.test(comments);
			if (ALLOW_ANY.test(comments)) {
				const at = p.text.indexOf("action-boundary-ok", commentStart);
				if (at >= 0) claimed.add(at);
			}
			let target = e.local !== null ? resolveLocal(file, e.local) : null;
			if (!target && e.local === null && ts.isExportDeclaration(e.statement)) target = resolveExport(file, e.name);
			const ok = target ? reaches(target.file, target.local, new Set()) : false;
			if (ok && marked) {
				findings.push(`${e.name}: carries an action-boundary-ok marker but DOES reach a session read — delete the stale marker`);
			} else if (!ok && !marked) {
				findings.push(
					target
						? `${e.name}: never reaches a session read — a public, unauthenticated Server Action`
						: `${e.name}: is not a function this guard can follow — a "use server" file may export only async functions`,
				);
			}
		}
		// Every marker in the file must be one an export claimed; anything else is an orphan.
		const any = new RegExp(ALLOW_ANY.source, "g");
		for (let m = any.exec(p.text); m !== null; m = any.exec(p.text)) {
			if (claimed.has(m.index)) {
				const eol = p.text.indexOf("\n", m.index);
				const line = p.text.slice(m.index, eol === -1 ? undefined : eol);
				if (!ALLOW.test(line)) findings.push("an action-boundary-ok marker has no reason on its own line");
				continue;
			}
			const lineNo = p.text.slice(0, m.index).split("\n").length;
			findings.push(`line ${lineNo}: an action-boundary-ok marker that no export claims — it must sit in the leading comment of the export it excuses`);
		}
		return { findings, exports: count };
	}

	return { analyse };
}

// ── probes: fired on every run, and alone under --self-test ──────────────────────────────────

const PROBE_ROOT = "/probe";
const PROBE_AUTH = `${PROBE_ROOT}/lib/auth/index.ts`;

/** In-memory fixtures. Each `expect` is the number of findings the probe file must produce. */
const PROBE_BASE = {
	[PROBE_AUTH]: `export const auth = { api: { getSession: async (_: unknown) => null } };`,
	[`${PROBE_ROOT}/lib/auth/owner.ts`]: `import { auth } from "@/lib/auth";
async function safe() { return auth.api.getSession({}); }
export async function requireOwner() { const s = await safe(); if (!s) throw new Error(); return "u"; }`,
	[`${PROBE_ROOT}/lib/authz/guard.ts`]: `import { requireOwner } from "@/lib/auth/owner";
export async function currentActor() { return { userId: await requireOwner() }; }
export async function authorize(_a: string) { return currentActor(); }`,
	[`${PROBE_ROOT}/lib/writes.ts`]: `export async function write() { return 1; }`,
	[`${PROBE_ROOT}/lib/gated.ts`]: `export { authorize as gate } from "@/lib/authz/guard";`,
	[`${PROBE_ROOT}/lib/fake-auth.ts`]: `export const auth = { api: { getSession: async () => null } };`,
};

/** @type {{ name: string, file: string, src: string, expect: number }[]} */
const PROBES = [
	{ name: "direct authorize passes", expect: 0, file: "a.ts", src: `"use server";
import { authorize } from "@/lib/authz/guard";
export async function ok() { await authorize("view"); }` },
	{ name: "a same-file helper that authorizes passes", expect: 0, file: "b.ts", src: `"use server";
import { currentActor } from "@/lib/authz/guard";
async function requireAdmin() { return currentActor(); }
export const ok = async () => { await requireAdmin(); };` },
	{ name: "a re-exported gate is followed", expect: 0, file: "c.ts", src: `"use server";
import { gate } from "@/lib/gated";
export async function ok() { await gate("x"); }` },
	{ name: "an unauthorized export in a MIXED file fails", expect: 1, file: "d.ts", src: `"use server";
import { authorize } from "@/lib/authz/guard";
import { write } from "@/lib/writes";
export async function ok() { await authorize("view"); }
export async function leak() { await write(); }` },
	{ name: "a LOCAL function named authorize does not count", expect: 1, file: "e.ts", src: `"use server";
async function authorize() { return 1; }
export async function leak() { await authorize(); }` },
	{ name: "a getSession on something that is not lib/auth's instance does not count", expect: 1, file: "f.ts", src: `"use server";
const auth = { api: { getSession: async () => null } };
export async function leak() { await auth.api.getSession(); }` },
	{ name: "an \`auth\` imported from anywhere but lib/auth does not count", expect: 1, file: "f2.ts", src: `"use server";
import { auth } from "@/lib/fake-auth";
export async function leak() { await auth.api.getSession(); }` },
	{ name: "a reasoned marker excuses exactly its export", expect: 1, file: "g.ts", src: `"use server";
import { write } from "@/lib/writes";
/** action-boundary-ok: public price list, no tenant data */
export async function prices() { await write(); }
export async function leak() { await write(); }` },
	{ name: "a marker on an export that authorizes is stale", expect: 1, file: "h.ts", src: `"use server";
import { authorize } from "@/lib/authz/guard";
// action-boundary-ok: was pre-auth once
export async function ok() { await authorize("view"); }` },
	{ name: "a file-header marker is an orphan and excuses nothing", expect: 2, file: "i.ts", src: `"use server";
// action-boundary-ok: the whole file is fine, trust me
import { write } from "@/lib/writes";

async function helper() { return 1; }
export async function leak() { await write(); await helper(); }` },
	{ name: "a bare marker excuses nothing", expect: 2, file: "j.ts", src: `"use server";
import { write } from "@/lib/writes";
// action-boundary-ok:
// public
export async function leak() { await write(); }` },
	{ name: "a non-function export is refused", expect: 1, file: "k.ts", src: `"use server";
export const LIMIT = 5;` },
	{ name: "an unparseable file is refused even when its exports would pass", expect: 1, file: "l.ts", src: `"use server";
import { authorize } from "@/lib/authz/guard";
export async function ok() { await authorize("view"); }
const broken = ;` },
	{ name: "a cycle between helpers terminates and fails", expect: 1, file: "m.ts", src: `"use server";
async function a(): Promise<number> { return b(); }
async function b(): Promise<number> { return a(); }
export async function leak() { await a(); }` },
];

/**
 * Run every probe through a fresh analyser over the in-memory fixtures.
 *
 * @returns {string[]} one line per probe that did not produce its expected number of findings
 */
function runProbes() {
	const failures = [];
	for (const probe of PROBES) {
		const file = `${PROBE_ROOT}/app/${probe.file}`;
		/** @type {Record<string, string>} */
		const fsMap = { ...PROBE_BASE, [file]: probe.src };
		const analyser = createAnalyser((f) => fsMap[f] ?? null, PROBE_AUTH, PROBE_ROOT);
		const got = analyser.analyse(file)?.findings ?? ["<not analysed>"];
		if (got.length !== probe.expect) {
			failures.push(`probe "${probe.name}": expected ${probe.expect} finding(s), got ${got.length}${got.length ? `: ${got.join("; ")}` : ""}`);
		}
	}
	return failures;
}

// ── the scan ─────────────────────────────────────────────────────────────────────────────────

/**
 * Every .ts/.tsx file under the console, minus build output, tests and scripts.
 *
 * @param {string} dir
 * @param {string[]} out
 */
function walk(dir, out) {
	for (const entry of fs.readdirSync(dir)) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = path.join(dir, entry);
		if (fs.statSync(full).isDirectory()) walk(full, out);
		else if (/\.tsx?$/.test(full) && !full.endsWith(".d.ts")) out.push(full);
	}
}

/**
 * Read a real file, or null when it does not exist.
 *
 * @param {string} file
 */
function readReal(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

const probeFailures = runProbes();
if (probeFailures.length > 0) {
	console.error("check-action-boundary: the analyser failed its own probes — it cannot be trusted to read the tree:");
	for (const f of probeFailures) console.error(`  ${f}`);
	process.exit(1);
}
if (process.argv.includes("--self-test")) {
	console.log(`check-action-boundary self-test: all ${PROBES.length} probes passed`);
	process.exit(0);
}

const files = [];
try {
	walk(CONSOLE, files);
} catch (err) {
	console.error(`check-action-boundary: cannot walk ${CONSOLE} — ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
}
if (readReal(AUTH_MODULE) === null) {
	console.error(`check-action-boundary: ${path.relative(CONSOLE, AUTH_MODULE)} is missing — the session leaf this guard follows to no longer exists.`);
	process.exit(1);
}

const actionFiles = files.filter((f) => USE_SERVER.test(readReal(f) ?? ""));
if (actionFiles.length === 0) {
	console.error(`check-action-boundary: found ${files.length} file(s) but NONE carry a "use server" directive.`);
	console.error("That is not a clean tree — it means this guard is looking at the wrong thing.");
	process.exit(1);
}

const analyser = createAnalyser(readReal, AUTH_MODULE, CONSOLE);
let exportCount = 0;
const violations = [];
for (const file of actionFiles) {
	const result = analyser.analyse(file);
	if (!result) continue;
	exportCount += result.exports;
	for (const finding of result.findings) violations.push(`${path.relative(CONSOLE, file)}: ${finding}`);
}

if (violations.length > 0) {
	console.error('Action-boundary violation — every export of a "use server" file is a public POST endpoint:');
	for (const v of violations) console.error(`  ${v}`);
	console.error("");
	console.error("Fix: a service-role / runner / cron path moves VERBATIM to lib/<domain>/ with no directive, and its");
	console.error("callers import it from there. A user-callable action authorizes first (authorize()/currentActor(), as");
	console.error("its siblings do). Only a genuinely pre-auth export takes `// action-boundary-ok: <reason>` in its own");
	console.error("leading comment.");
	process.exit(1);
}

console.log(
	`OK — ${exportCount} export(s) across ${actionFiles.length} "use server" file(s); every one reaches a session read or carries a reasoned exception.`,
);
