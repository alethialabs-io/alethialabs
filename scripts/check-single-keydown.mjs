#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Fails when console code listens for keyboard events at page level anywhere except the shortcut
// registry in apps/console/lib/shortcuts/ (#6928, spec CON-G4).
//
// WHY THIS EXISTS. Every keyboard shortcut in the console is a row in
// apps/console/lib/shortcuts/registry.ts, and `useShortcut` (use-shortcut.ts beside it) is the one
// `keydown` listener that reads the table. The registry is where the rules live — Tab is never
// bound, a global shortcut holds a modifier, two rows in one scope may not answer one chord, a
// narrower scope wins — and a second listener answers keys without any of them. Before the
// registry, three files each held their own, and one of them took Shift+Tab away from the browser.
//
// WHAT IS MATCHED, in every file this reads (comments are stripped first; strings are not):
//   · key-listener         — `addEventListener(` or `removeEventListener(` whose first argument is
//                            the string or template literal "keydown", "keyup" or "keypress", on
//                            ANY receiver (`window.`, `document.`, `globalThis.`, an alias, a ref,
//                            or none), across line breaks. The receiver is deliberately not read:
//                            the source text cannot tell `ref.current` from `const doc = document`,
//                            and a key handled by one element is an `onKeyDown` prop on it.
//   · key-handler-property — an assignment to `.onkeydown`, `.onkeyup` or `.onkeypress` (the DOM
//                            property handler: `window.onkeydown = …`).
//   · key-event-name       — any OTHER string or template literal that is exactly one of those
//                            three event names. This is what catches the forms that never write
//                            `addEventListener("keydown"` at all: the name held in a constant and
//                            passed later, a listener hook (`useEventListener("keydown", …)`),
//                            `fromEvent(window, "keydown")`, and a synthesized
//                            `new KeyboardEvent("keydown")`.
//   · key-library          — an import or require of a dedicated keyboard-shortcut package
//                            (KEY_LIBRARIES below), each of which installs its own listener.
// A `useEffect` that installs a listener is matched by the first three wherever it sits — the
// effect is where such a listener lives, not a separate form.
//
// WHAT IS READ. Tracked `.ts/.tsx/.js/.jsx/.mjs` files under apps/console and every
// `packages/<name>/src/` (the shared packages the console bundles), minus tests (`tests/`, `e2e/`,
// `__tests__/`, `*.test.*`, `*.spec.*`), type declarations, and build scripts
// (`apps/console/scripts/`). Files directly in apps/console/lib/shortcuts/ are exempt by location:
// that is the registry. The real run also requires that directory to still HOLD a key listener —
// if the registry's listener moves, the exemption points at nothing and this fails rather than
// guarding an empty room.
//
// WHAT IS DELIBERATELY NOT MATCHED, so nobody reads this as more than it is:
//   · React's element-scoped props — `onKeyDown`, `onKeyUp`, `onKeyDownCapture` and the rest. A
//     key handled by the focused element (a menu's arrow keys, a field's Enter) belongs there;
//     the property rule is lower-case and needs a `.` receiver, so a JSX prop never matches it;
//   · an event name built at run time (`"key" + "down"`, `` `key${kind}` `` with an expression) —
//     this reads literals, not values;
//   · a general-purpose hook library whose key hook takes no event name (`useKey("Enter")` from
//     react-use): that is a whole package, and banning it for one hook would be wrong. A
//     dedicated shortcut package is listed in KEY_LIBRARIES instead; a new one belongs there;
//   · listeners installed inside third-party packages (a Radix layer's own Escape handling) —
//     node_modules is not console code;
//   · `ee/` and every other app: the rule is the console's.
// The comment stripper is the tokenizer from check-secure-context-apis.mjs, not a parser: an
// apostrophe in JSX text can be misread as a quote. A misread that opens a string keeps text, so
// it can only add a finding; a quote string is closed at its line's end, so no misread outlives
// the line.
//
// THE LEDGER is scripts/single-keydown-allowlist.yaml: `{ file, rule, reason }` entries, each a
// decision that a file genuinely needs its own listener. It is checked in BOTH directions — a
// finding with no entry fails, and an entry that excuses nothing fails as stale — and it is
// parsed strictly: a line the parser does not recognise fails, so a malformed entry cannot read
// as an empty list.
//
// Usage:  node scripts/check-single-keydown.mjs [--self-test]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "scripts/single-keydown-allowlist.yaml";
/** The registry: the one place a page-level key listener may live. */
export const REGISTRY_DIR = "apps/console/lib/shortcuts/";

export const RULE_IDS = ["key-listener", "key-handler-property", "key-event-name", "key-library"];

/** Packages whose whole job is binding keyboard shortcuts — each installs its own listener. */
export const KEY_LIBRARIES = [
	"react-hotkeys-hook",
	"react-hotkeys",
	"hotkeys-js",
	"mousetrap",
	"tinykeys",
	"keymaster",
	"@github/hotkey",
	"react-keyboard-event-handler",
];

const FIX =
	'register a row with registerShortcuts() in apps/console/lib/shortcuts/registry.ts (or your surface\'s own module) and answer it with useShortcut(id, handler); a key for one element is an onKeyDown prop on it';

const EXTS = /\.(ts|tsx|js|jsx|mjs)$/;

/** Is this tracked path one the guard reads (by location alone)? */
export function inScope(path) {
	if (!EXTS.test(path)) return false;
	if (!(path.startsWith("apps/console/") || /^packages\/[^/]+\/src\//.test(path))) return false;
	if (/(^|\/)(tests|e2e|__tests__|node_modules)\//.test(path)) return false;
	if (path.startsWith("apps/console/scripts/")) return false;
	if (/\.(test|spec)\.[a-z]+$/.test(path)) return false;
	if (/\.d\.ts$/.test(path)) return false;
	return true;
}

/** Is this path the registry itself (a file directly in apps/console/lib/shortcuts/)? */
export function isRegistry(path) {
	return path.startsWith(REGISTRY_DIR) && !path.slice(REGISTRY_DIR.length).includes("/");
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
			if (ch === '"' || ch === "'" || ch === "`") stack.push(ch);
			else if (ch === "{" && stack.length > 1) stack.push("code");
			else if (ch === "}" && stack.length > 1) stack.pop();
			out += ch;
			i++;
			continue;
		}
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

/** A literal that is exactly a key event name, in any quote style. Case-insensitive on purpose. */
const KEY_NAME = /(["'`])(keydown|keyup|keypress)\1/gi;
/** The call a listener literal is the first argument of, ending right before the literal. */
const LISTENER_CALL = /\b(?:add|remove)EventListener\s*\(\s*$/;
const HANDLER_PROPERTY = /\.\s*onkey(?:down|up|press)\s*=(?![=>])/g;

/** The 1-based line of an offset in a text. */
function lineAt(text, offset) {
	let n = 1;
	for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

/** The import/require pattern for one package name (exact, or a subpath of it). */
function libraryPattern(name) {
	const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	return new RegExp(
		`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)(["'\`])${esc}(?:/[^"'\`]*)?\\1`,
		"g",
	);
}

/**
 * Findings for one source text, ignoring scope: `{ rule, line, text }` for every match outside a
 * comment. Exported so the real run can ask whether the registry still holds its listener.
 */
export function findListeners(src) {
	const code = stripComments(src);
	const raw = src.split("\n");
	const out = [];
	const push = (rule, offset) => {
		const line = lineAt(code, offset);
		out.push({ rule, line, text: (raw[line - 1] ?? "").trim() });
	};
	for (const m of code.matchAll(KEY_NAME)) {
		const before = code.slice(Math.max(0, m.index - 200), m.index);
		push(LISTENER_CALL.test(before) ? "key-listener" : "key-event-name", m.index);
	}
	for (const m of code.matchAll(HANDLER_PROPERTY)) push("key-handler-property", m.index);
	for (const name of KEY_LIBRARIES) {
		for (const m of code.matchAll(libraryPattern(name))) push("key-library", m.index);
	}
	return out.sort((a, b) => a.line - b.line);
}

/** Findings for one tracked file: none when it is out of scope or is the registry. */
export function scanSource(path, src) {
	if (!inScope(path) || isRegistry(path)) return [];
	return findListeners(src);
}

/**
 * Applies the ledger to the findings of a set of files. Returns the violations, and the entries
 * that excused nothing (stale), which fail too. One entry excuses every finding of its rule in its
 * file.
 */
export function evaluate(files, ledger) {
	const violations = [];
	const used = new Set();
	for (const [path, src] of files) {
		for (const f of scanSource(path, src)) {
			const entry = ledger.findIndex((a) => a.file === path && a.rule === f.rule);
			if (entry >= 0) used.add(entry);
			else violations.push({ path, ...f });
		}
	}
	const stale = ledger.filter((_, i) => !used.has(i));
	return { violations, stale };
}

/**
 * Parses the ledger YAML — the one shape the file documents, nothing more. Throws on any line it
 * does not recognise, on an entry missing a field, on an unknown rule and on a duplicate, so a
 * malformed ledger fails instead of reading as empty.
 */
export function parseLedger(text) {
	const entries = [];
	let sawKey = false;
	let inline = false;
	let current = null;
	const finish = () => {
		if (!current) return;
		for (const k of ["file", "rule", "reason"]) {
			if (!current[k]) throw new Error(`ledger entry is missing "${k}": ${JSON.stringify(current)}`);
		}
		if (!RULE_IDS.includes(current.rule)) throw new Error(`ledger entry has unknown rule "${current.rule}"`);
		if (entries.some((e) => e.file === current.file && e.rule === current.rule))
			throw new Error(`ledger lists ${current.file} / ${current.rule} twice`);
		entries.push(current);
		current = null;
	};
	text.split("\n").forEach((rawLine, n) => {
		const line = rawLine.replace(/\s+$/, "");
		if (line === "" || /^\s*#/.test(line)) return;
		const where = `${LEDGER}:${n + 1}`;
		if (!sawKey) {
			const top = /^entries:\s*(\[\])?$/.exec(line);
			if (!top) throw new Error(`${where}: expected "entries:" — got ${JSON.stringify(line)}`);
			sawKey = true;
			inline = top[1] !== undefined;
			return;
		}
		if (inline) throw new Error(`${where}: "entries: []" is empty, but a line follows it`);
		const field = /^ {2}(- | {2})(file|rule|reason):\s+(.+)$/.exec(line);
		if (!field) throw new Error(`${where}: not an entry field — ${JSON.stringify(line)}`);
		if (field[1] === "- ") {
			finish();
			current = {};
		} else if (!current) throw new Error(`${where}: a field before any "- " entry`);
		if (current[field[2]] !== undefined) throw new Error(`${where}: "${field[2]}" given twice`);
		current[field[2]] = field[3].replace(/^(["'])(.*)\1$/, "$2");
	});
	finish();
	if (!sawKey) throw new Error(`${LEDGER}: no "entries:" key`);
	return entries;
}

/** The tracked files this guard reads, with their contents (registry files included). */
function trackedSources(root) {
	const listed = execFileSync("git", ["ls-files", "-z", "apps/console", "packages"], {
		cwd: root,
		maxBuffer: 64 * 1024 * 1024,
	})
		.toString()
		.split("\0")
		.filter((p) => p && inScope(p));
	return listed.map((p) => [p, readFileSync(join(root, p), "utf8")]);
}

/** Does the registry directory still hold a key listener? False means the exemption is stale. */
export function registryHoldsListener(files) {
	for (const [path, src] of files) {
		if (isRegistry(path) && findListeners(src).some((f) => f.rule === "key-listener")) return true;
	}
	return false;
}

/** Prints the result and returns the exit code. */
function report({ violations, stale }, scanned, registryOk) {
	for (const v of violations) console.error(`✗ ${v.path}:${v.line}  [${v.rule}]  ${v.text}\n    ${FIX}`);
	for (const s of stale) {
		console.error(`✗ stale ledger entry: ${s.file} no longer produces ${s.rule} — delete it from ${LEDGER}`);
	}
	if (!registryOk) {
		console.error(
			`✗ no file directly in ${REGISTRY_DIR} adds a key listener any more — the registry's exemption points at nothing. ` +
				"Move REGISTRY_DIR in this script to where the one listener now lives.",
		);
	}
	if (violations.length || stale.length || !registryOk) {
		console.error(
			`\ncheck-single-keydown: ${violations.length} key listener(s) outside the registry, ${stale.length} stale ledger entr(ies).`,
		);
		return 1;
	}
	console.log(`✓ check-single-keydown: ${scanned} console files, one key listener (${REGISTRY_DIR})`);
	return 0;
}

/** Each case is [description, files, expected violation rules]. The exit code is the test. */
function selfTest() {
	const C = "apps/console/components/x.tsx";
	const cases = [
		["window.addEventListener keydown", [[C, 'window.addEventListener("keydown", onKey);']], ["key-listener"]],
		["document keyup, single quotes", [[C, "document.addEventListener('keyup', onKey);"]], ["key-listener"]],
		["keypress in a template literal", [[C, "document.addEventListener(`keypress`, onKey);"]], ["key-listener"]],
		["optional chaining on globalThis", [[C, 'globalThis.window?.addEventListener("keydown", f);']], ["key-listener"]],
		["an aliased receiver", [[C, 'const doc = document;\ndoc.addEventListener("keydown", f);']], ["key-listener"]],
		["a bare global call", [[C, 'addEventListener("keydown", f);']], ["key-listener"]],
		["across line breaks", [[C, "window.addEventListener(\n\t\t\"keydown\",\n\t\tf,\n);"]], ["key-listener"]],
		["mixed case event name", [[C, 'window.addEventListener("keyDown", f);']], ["key-listener"]],
		[
			"inside a useEffect",
			[[C, 'useEffect(() => {\n\twindow.addEventListener("keydown", f);\n\treturn () => window.removeEventListener("keydown", f);\n}, []);']],
			["key-listener", "key-listener"],
		],
		["the name held in a constant", [[C, 'const EVT = "keydown";\nwindow.addEventListener(EVT, f);']], ["key-event-name"]],
		["a listener hook", [[C, 'useEventListener("keydown", f);']], ["key-event-name"]],
		["rxjs fromEvent", [[C, 'fromEvent(window, "keyup");']], ["key-event-name"]],
		["window.onkeydown =", [[C, "window.onkeydown = (e) => go(e);"]], ["key-handler-property"]],
		["document.onkeyup =", [[C, "document.onkeyup = null;"]], ["key-handler-property"]],
		["a hotkey library import", [[C, 'import { useHotkeys } from "react-hotkeys-hook";']], ["key-library"]],
		["a library subpath import", [[C, 'import x from "tinykeys/dist/x";']], ["key-library"]],
		["a library require", [[C, 'const m = require("mousetrap");']], ["key-library"]],
		["a dynamic library import", [[C, 'await import("hotkeys-js");']], ["key-library"]],
		["packages/ui is read", [["packages/ui/src/x.tsx", 'document.addEventListener("keydown", f);']], ["key-listener"]],
		["a registry subdirectory is not the registry", [[`${REGISTRY_DIR}x/y.ts`, 'document.addEventListener("keydown", f);']], ["key-listener"]],
		// Negative controls: these must stay silent.
		["an onKeyDown prop is element-scoped", [[C, "<div onKeyDown={(e) => go(e)} onKeyUpCapture={f} />"]], []],
		["a comparison is not an assignment", [[C, "if (window.onkeydown == null) {}"]], []],
		["another event type", [[C, 'window.addEventListener("keydownish", f); window.addEventListener("resize", f);']], []],
		["a line comment is not code", [[C, '// window.addEventListener("keydown", f)']], []],
		["a block comment is not code", [[C, '/**\n * document.addEventListener("keydown")\n */\nconst a = 1;']], []],
		["the registry itself is exempt", [[`${REGISTRY_DIR}use-shortcut.ts`, 'document.addEventListener("keydown", f);']], []],
		["a test is out of scope", [["apps/console/tests/x.test.tsx", 'window.addEventListener("keydown", f);']], []],
		["a colocated spec is out of scope", [["apps/console/components/x.spec.ts", 'new KeyboardEvent("keydown");']], []],
		["an e2e file is out of scope", [["apps/console/e2e/x.ts", 'page.keyboard; "keydown";']], []],
		["ee is out of scope", [["ee/src/x.tsx", 'window.addEventListener("keydown", f);']], []],
		["an unrelated package name", [[C, 'import x from "react-hotkeys-hookish";']], []],
	];
	let failed = 0;
	for (const [name, files, want] of cases) {
		const { violations, stale } = evaluate(new Map(files), []);
		const got = violations.map((v) => v.rule);
		if (JSON.stringify(got) !== JSON.stringify(want) || stale.length) {
			failed++;
			console.error(`✗ self-test: ${name}: got ${JSON.stringify(got)} / stale ${stale.length}, want ${JSON.stringify(want)}`);
		}
	}
	// Line numbers name the literal's line, not the call's first line.
	const lined = evaluate(new Map([[C, "a;\nwindow.addEventListener(\n\t\"keydown\", f);"]]), []).violations[0];
	if (lined?.line !== 3) {
		failed++;
		console.error(`✗ self-test: reported line ${lined?.line}, want 3`);
	}
	// The ledger excuses only its own (file, rule), and an unused entry fails as stale.
	const ledger = [{ file: C, rule: "key-handler-property", reason: "test" }];
	const excused = evaluate(new Map([[C, 'window.onkeydown = f; window.addEventListener("keyup", f);']]), ledger);
	if (excused.violations.length !== 1 || excused.violations[0].rule !== "key-listener" || excused.stale.length) {
		failed++;
		console.error("✗ self-test: a ledger entry excused the wrong rule, or none");
	}
	if (evaluate(new Map([[C, "const a = 1;"]]), ledger).stale.length !== 1) {
		failed++;
		console.error("✗ self-test: a ledger entry that excuses nothing was not reported stale");
	}
	// The registry check: present, then moved away.
	const reg = [[`${REGISTRY_DIR}use-shortcut.ts`, 'document.addEventListener("keydown", f);']];
	if (!registryHoldsListener(new Map(reg)) || registryHoldsListener(new Map([[`${REGISTRY_DIR}registry.ts`, "const a = 1;"]]))) {
		failed++;
		console.error("✗ self-test: registryHoldsListener did not tell a listener from its absence");
	}
	// The parser: the empty form, a full entry, and every malformed shape must throw.
	const parsed = parseLedger(
		`# c\nentries:\n  - file: ${C}\n    rule: key-listener\n    reason: "a decision"\n`,
	);
	if (parsed.length !== 1 || parsed[0].reason !== "a decision" || parseLedger("entries: []\n").length !== 0) {
		failed++;
		console.error("✗ self-test: parseLedger misread a well-formed ledger");
	}
	const malformed = [
		["no entries key", "# only a comment\n"],
		["content after []", `entries: []\n  - file: ${C}\n`],
		["a missing reason", `entries:\n  - file: ${C}\n    rule: key-listener\n`],
		["an unknown rule", `entries:\n  - file: ${C}\n    rule: keydown\n    reason: r\n`],
		["a mis-indented field", `entries:\n  - file: ${C}\n   rule: key-listener\n    reason: r\n`],
		["a duplicate entry", `entries:\n  - file: ${C}\n    rule: key-listener\n    reason: r\n  - file: ${C}\n    rule: key-listener\n    reason: s\n`],
	];
	for (const [name, text] of malformed) {
		let threw = false;
		try {
			parseLedger(text);
		} catch {
			threw = true;
		}
		if (!threw) {
			failed++;
			console.error(`✗ self-test: parseLedger accepted ${name}`);
		}
	}
	// The real ledger parses, and every entry names a file the guard reads outside the registry.
	try {
		for (const e of parseLedger(readFileSync(join(ROOT, LEDGER), "utf8"))) {
			if (!inScope(e.file) || isRegistry(e.file)) {
				failed++;
				console.error(`✗ self-test: ledger entry ${e.file} is outside the scanned scope`);
			}
		}
	} catch (err) {
		failed++;
		console.error(`✗ self-test: ${LEDGER} does not parse: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (failed) {
		console.error(`check-single-keydown --self-test: ${failed} failure(s)`);
		return 1;
	}
	console.log("✓ check-single-keydown --self-test: every case behaves");
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv.includes("--self-test")) process.exit(selfTest());
	let ledger;
	try {
		ledger = parseLedger(readFileSync(join(ROOT, LEDGER), "utf8"));
	} catch (err) {
		console.error(`✗ check-single-keydown: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
	const files = new Map(trackedSources(ROOT));
	process.exit(report(evaluate(files, ledger), files.size, registryHoldsListener(files)));
}
