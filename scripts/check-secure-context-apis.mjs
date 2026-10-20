#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Fails when browser code in the console or the shared UI kit reaches for a browser API that exists
// only in a SECURE CONTEXT (HTTPS, or localhost), without a fallback.
//
// WHY THIS EXISTS. A self-hosted console may be served over plain HTTP on a private network. There,
// `crypto.randomUUID` is `undefined`, so `crypto.randomUUID()` throws; `navigator.clipboard` is
// `undefined`, so `navigator.clipboard.writeText(...)` throws; `crypto.subtle` is `undefined`. None
// of that is visible on localhost or on the hosted service, which are both secure contexts, so every
// test and every preview passes. #6182 found one in the app shell (the Elench drafts root, mounted
// on every page), and the sweep behind it found the same call in five more client modules and an
// unguarded `navigator.clipboard` in five copy buttons.
//
// WHAT IS MATCHED, in every file this reads (comments are stripped first; strings are NOT, so
// `\`x-${crypto.randomUUID()}\`` is caught):
//   · `crypto.randomUUID`   — any access, called or passed. Use `randomUuid` from
//                             `apps/console/lib/random-id.ts` (built on `crypto.getRandomValues`,
//                             which every context has).
//   · `navigator.clipboard` — use `copyText` from `@repo/ui/copy-text`, which falls back to a
//                             selection copy and says whether the copy happened.
//   · `crypto.subtle`       — WebCrypto has no insecure-context fallback; the one user is listed in
//                             ALLOWED with the guard that makes it safe.
// Each is matched with `?.` and `globalThis.`/`window.`/`self.` prefixes too (`\bcrypto\b` and
// `\bnavigator\b` are words in all of those).
//
// WHAT IS READ. Tracked `.ts/.tsx/.js/.jsx/.mjs` files under apps/console and packages/ui/src, minus
// tests (`tests/`, `e2e/`, `*.test.*`, `*.spec.*`), build scripts (`apps/console/scripts/`) and
// files that are SERVER code by a structural marker: `import "server-only"`, a `"use server"`
// directive, or a route handler (`route.ts` / `apps/console/app/api/`). The client import graph is
// deliberately NOT computed: any file without a server marker might be bundled for the browser, so
// it is held to the browser rule (fail closed). Server code that needs a UUID imports `randomUUID`
// from `node:crypto`, which this does not match.
//
// WHAT IS DELIBERATELY NOT MATCHED, so nobody reads this as more than it is:
//   · a destructured or aliased access (`const { randomUUID } = crypto`, `const c = crypto;
//     c.randomUUID()`) — this reads the source text, not the binding;
//   · `navigator.locks`, `navigator.serviceWorker`, `navigator.credentials` and `Notification`:
//     on 2026-10-20 none of them was used by console or UI-kit browser code, and
//     `navigator.locks` arrives with #6115's real-time client, which already falls back when it is
//     absent. A rule for them belongs with their first use, where its allow-entry can name the file;
//   · `ee/` and every other app — the self-hosted surface is the console.
// The comment stripper is a tokenizer, not a parser: an apostrophe in JSX text or a regex literal
// can be misread as a quote. A misread that opens a string keeps text, so it can only add a
// finding; one that leaves a real string's `//` (a URL in JSX text) looking like code drops the rest
// of that one line. A quote string is closed at its line's end, so no misread outlives the line.
//
// ALLOWED is checked in BOTH directions: an entry whose file no longer matches its rule fails as
// stale, so an exception cannot outlive the code it excuses.
//
// Usage:  node scripts/check-secure-context-apis.mjs [--self-test]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The SecureContext-only APIs this guard reads for, and what to use instead. */
export const RULES = [
	{
		id: "randomUUID",
		re: /\bcrypto\s*\??\.\s*randomUUID\b/,
		fix: 'use randomUuid() from "@/lib/random-id" (crypto.randomUUID is undefined over plain HTTP)',
	},
	{
		id: "clipboard",
		re: /\bnavigator\s*\??\.\s*clipboard\b/,
		fix: 'use copyText() from "@repo/ui/copy-text" (navigator.clipboard is undefined over plain HTTP)',
	},
	{
		id: "subtle",
		re: /\bcrypto\s*\??\.\s*subtle\b/,
		fix: "crypto.subtle is undefined over plain HTTP; gate the feature on window.isSecureContext and say so in the UI",
	},
];

/** The files that may use a rule's API, each with the guard that makes it safe. */
export const ALLOWED = [
	{
		file: "packages/ui/src/copy-text.ts",
		rule: "clipboard",
		why: "the one writer: it checks navigator.clipboard and falls back to a selection copy",
	},
	{
		file: "apps/console/components/connectors/azure-connection.tsx",
		rule: "clipboard",
		why: "readText has no insecure fallback; it checks for the API and tells the person to paste into a field instead",
	},
	{
		file: "apps/console/components/clusters/kubeconfig-download/hpke.ts",
		rule: "subtle",
		why: "the caller (kubeconfig-download.tsx) checks window.isSecureContext first and points to the CLI over plain HTTP",
	},
];

const EXTS = /\.(ts|tsx|js|jsx|mjs)$/;

/** Is this tracked path one the guard reads (by location alone)? */
export function inScope(path) {
	if (!EXTS.test(path)) return false;
	if (!(path.startsWith("apps/console/") || path.startsWith("packages/ui/src/"))) return false;
	if (/(^|\/)(tests|e2e|__tests__|node_modules)\//.test(path)) return false;
	if (path.startsWith("apps/console/scripts/")) return false;
	if (/\.(test|spec)\.[a-z]+$/.test(path)) return false;
	if (/\.d\.ts$/.test(path)) return false;
	if (path.startsWith("apps/console/app/api/") || /(^|\/)route\.(ts|js)$/.test(path)) return false;
	return true;
}

/** Does this source declare itself server code, by `import "server-only"` or `"use server"`? */
export function isServerModule(code) {
	if (/^\s*import\s+["']server-only["'];?\s*$/m.test(code)) return true;
	return /^\s*["']use server["'];?\s*$/m.test(code);
}

/**
 * Removes `//` and `/* *\/` comments, keeping string and template-literal contents (a template's
 * `${…}` is code). Line breaks are kept so reported line numbers stay right. A quote string that
 * reaches a newline is closed there, which bounds the damage of a misread regex literal to a line.
 */
export function stripComments(src) {
	let out = "";
	/** Stack of open contexts: "code", or the quote char of an open string. The bottom is code. */
	const stack = ["code"];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		const next = src[i + 1];
		const top = stack[stack.length - 1];
		if (top === "code") {
			if (ch === "/" && next === "/") {
				while (i < src.length && src[i] !== "\n") i++;
				continue;
			}
			if (ch === "/" && next === "*") {
				const end = src.indexOf("*/", i + 2);
				const stop = end === -1 ? src.length : end + 2;
				out += src.slice(i, stop).replace(/[^\n]/g, "");
				i = stop;
				continue;
			}
			// Inside a template's `${…}`, a `{` opens a nested code level and `}` closes one; the
			// last `}` returns to the template.
			if (ch === '"' || ch === "'" || ch === "`") stack.push(ch);
			else if (ch === "{" && stack.length > 1) stack.push("code");
			else if (ch === "}" && stack.length > 1) stack.pop();
			out += ch;
			i++;
			continue;
		}
		// Inside a string.
		if (ch === "\\") {
			out += src.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (top === "`" && ch === "$" && next === "{") {
			stack.push("code");
			out += "${";
			i += 2;
			continue;
		}
		if (ch === top) stack.pop();
		else if (ch === "\n" && top !== "`") stack.pop();
		out += ch;
		i++;
	}
	return out;
}

/** Findings for one file's source: `{ rule, line, text }` for every rule match outside a comment. */
export function scanSource(path, src) {
	if (!inScope(path) || isServerModule(src)) return [];
	const code = stripComments(src).split("\n");
	const raw = src.split("\n");
	const out = [];
	code.forEach((line, n) => {
		for (const rule of RULES) {
			if (rule.re.test(line)) out.push({ rule: rule.id, line: n + 1, text: (raw[n] ?? "").trim() });
		}
	});
	return out;
}

/**
 * Applies ALLOWED to the findings of a set of files. Returns the violations, and the allow-entries
 * that excused nothing (stale), which fail too.
 */
export function evaluate(files, allowed = ALLOWED) {
	const violations = [];
	const used = new Set();
	for (const [path, src] of files) {
		for (const f of scanSource(path, src)) {
			const entry = allowed.findIndex((a) => a.file === path && a.rule === f.rule);
			if (entry >= 0) used.add(entry);
			else violations.push({ path, ...f });
		}
	}
	const stale = allowed.filter((_, i) => !used.has(i));
	return { violations, stale };
}

/** The tracked files this guard reads, with their contents. */
function trackedSources(root) {
	const listed = execFileSync("git", ["ls-files", "-z", "apps/console", "packages/ui/src"], {
		cwd: root,
		maxBuffer: 64 * 1024 * 1024,
	})
		.toString()
		.split("\0")
		.filter((p) => p && inScope(p));
	return listed.map((p) => [p, readFileSync(join(root, p), "utf8")]);
}

/** Prints the result and returns the exit code. */
function report({ violations, stale }, scanned) {
	for (const v of violations) {
		const rule = RULES.find((r) => r.id === v.rule);
		console.error(`✗ ${v.path}:${v.line}  ${v.text}\n    ${rule?.fix ?? ""}`);
	}
	for (const s of stale) {
		console.error(`✗ stale allow-entry: ${s.file} no longer uses ${s.rule} — delete the entry`);
	}
	if (violations.length || stale.length) {
		console.error(
			`\ncheck-secure-context-apis: ${violations.length} unguarded use(s), ${stale.length} stale allow-entr(ies). ` +
				"These APIs are undefined when the console is served over plain HTTP.",
		);
		return 1;
	}
	console.log(`✓ check-secure-context-apis: ${scanned} browser-reachable files, no unguarded SecureContext-only API`);
	return 0;
}

/** Each case is [description, files, expected violation rules, expected stale count]. */
function selfTest() {
	const C = "apps/console/components/x.tsx";
	const cases = [
		["a client call is caught", [[C, '"use client";\nconst id = crypto.randomUUID();']], ["randomUUID"], 0],
		["a reference (not a call) is caught", [[C, "mint: crypto.randomUUID,"]], ["randomUUID"], 0],
		["inside a template expression is caught", [[C, "const id = `opt-${crypto.randomUUID()}`;"]], ["randomUUID"], 0],
		["optional chaining and globalThis are caught", [[C, "globalThis.crypto?.randomUUID();"]], ["randomUUID"], 0],
		["a URL in a string does not hide the call after it", [[C, 'const u = "http://x"; crypto.randomUUID();']], ["randomUUID"], 0],
		["a line comment is not code", [[C, "// crypto.randomUUID() is undefined over HTTP"]], [], 0],
		["a comment inside a template expression is not code", [[C, "const s = `a${/* crypto.randomUUID() */ b}`;"]], [], 0],
		["a nested template does not end the outer one", [[C, "const s = `a${`b`}c`; // crypto.randomUUID()"]], [], 0],
		["a block comment is not code", [[C, "/**\n * crypto.randomUUID()\n */\nconst a = 1;"]], [], 0],
		["node:crypto's randomUUID is not matched", [[C, 'import { randomUUID } from "node:crypto";\nrandomUUID();']], [], 0],
		["a server-only module is exempt", [[C, 'import "server-only";\ncrypto.randomUUID();']], [], 0],
		["a use-server module is exempt", [[C, '"use server";\ncrypto.randomUUID();']], [], 0],
		["a route handler is exempt", [["apps/console/app/x/route.ts", "crypto.randomUUID();"]], [], 0],
		["a test is out of scope", [["apps/console/tests/x.test.ts", "crypto.randomUUID();"]], [], 0],
		["packages/ui is read", [["packages/ui/src/x.tsx", "navigator.clipboard.writeText(t);"]], ["clipboard"], 0],
		["crypto.subtle is caught", [[C, "await crypto.subtle.digest(a, b);"]], ["subtle"], 0],
		["a line number is reported", [[C, "a;\nb;\ncrypto.randomUUID();"]], ["randomUUID"], 0],
	];
	let failed = 0;
	const allowNone = [];
	for (const [name, files, want, wantStale] of cases) {
		const { violations, stale } = evaluate(new Map(files), allowNone);
		const got = violations.map((v) => v.rule);
		const ok = JSON.stringify(got) === JSON.stringify(want) && stale.length === wantStale;
		if (!ok) {
			failed++;
			console.error(`✗ self-test: ${name}: got ${JSON.stringify(got)} / stale ${stale.length}`);
		}
	}
	// Line numbers: the third line, not the first.
	const lined = evaluate(new Map([[C, "a;\nb;\ncrypto.randomUUID();"]]), allowNone).violations[0];
	if (lined?.line !== 3) {
		failed++;
		console.error(`✗ self-test: reported line ${lined?.line}, want 3`);
	}
	// The allow list excuses only its own (file, rule), and an unused entry fails as stale.
	const allow = [{ file: C, rule: "clipboard", why: "test" }];
	const excused = evaluate(new Map([[C, "navigator.clipboard.writeText(t); crypto.randomUUID();"]]), allow);
	if (excused.violations.length !== 1 || excused.violations[0].rule !== "randomUUID" || excused.stale.length) {
		failed++;
		console.error("✗ self-test: an allow-entry excused the wrong rule, or none");
	}
	const stale = evaluate(new Map([[C, "const a = 1;"]]), allow);
	if (stale.stale.length !== 1) {
		failed++;
		console.error("✗ self-test: an allow-entry that excuses nothing was not reported stale");
	}
	// Every real allow-entry names a file this guard actually reads.
	for (const a of ALLOWED) {
		if (!inScope(a.file)) {
			failed++;
			console.error(`✗ self-test: allow-entry ${a.file} is outside the scanned scope`);
		}
	}
	if (failed) {
		console.error(`check-secure-context-apis --self-test: ${failed} failure(s)`);
		return 1;
	}
	console.log("✓ check-secure-context-apis --self-test: every case behaves");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--self-test")) {
		process.exit(selfTest());
	}
	const files = trackedSources(ROOT);
	process.exit(report(evaluate(new Map(files)), files.length));
}
