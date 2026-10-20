#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// LIVE BY DEFAULT: THE CONSOLE DOES NOT POLL FOR DATA (ADR 0005 §7 Q3 + §10 R7, #6115).
//
// Anything that can change without the viewer's own action is invalidated by a topic on the org's
// change stream (lib/realtime/), not re-read on a timer. While the stream is down, ONE sanctioned
// poll (`lib/realtime/client/fallback-poll.ts`) covers every topic. Every other data poll is debt
// that a named lane removes.
//
// WHAT IS MATCHED, per console source file (app/ components/ hooks/ lib/, .ts/.tsx, no tests),
// on lines that are not comment-only lines:
//   · `refetchInterval:` with any value but the literal `false` — TanStack's poll, number or
//     function form;
//   · `setInterval(` — including `window.setInterval(` and `globalThis.x = setInterval(`.
//     `clearInterval(` is not a match.
// Counts are per file and per kind (`<file> :: refetchInterval`, `<file> :: setInterval`).
//
// WHAT IS NOT MATCHED, stated so nobody infers coverage that is not there:
//   · a recursive `setTimeout` that reschedules itself (a poll with no interval call in it);
//   · a `useEffect` + `setTimeout` loop, and `router.refresh()` driven by anything but an interval;
//   · a timer created in one file through a helper defined in another — it is counted in the file
//     that calls `setInterval(`, which is where the ledger asks for its reason.
// The ledger cannot tell a data poll from a real timer by reading code: a `setInterval` is filed
// under `timers` with a stated `reason` (a heartbeat, a sweeper, a clock tick) or under `polls` with
// the lane that `lifts` it. That classification is a REVIEW question; what this script enforces is
// that it was made, that it stays true to the tree, and that the poll side only shrinks.
//
// THE LEDGER (`apps/console/no-polling-ledger.json`):
//   { "sanctioned": { "<file> :: <kind>": { count, reason } },     ← exactly one: the fallback poll
//     "timers":     { "<file> :: setInterval": { count, reason } },
//     "polls":      { "<file> :: <kind>": { count, lifts: "#NNNN" | "unassigned" } } }
// It fails in BOTH directions: a match not in the ledger, a ledger entry no longer found, and a
// count that differs either way. A `refetchInterval` is always a poll. No poll may live under
// lib/realtime/ except the sanctioned one. Against the base branch's ledger (default origin/dev),
// the polls may only SHRINK: no new poll key, no higher count, and no poll re-filed as a timer.
//
// Usage: node scripts/check-no-polling.mjs [--base=<git ref>] [--write] [--self-test]

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONSOLE = join(ROOT, "apps/console");
const LEDGER_REL = "apps/console/no-polling-ledger.json";
const LEDGER = join(ROOT, LEDGER_REL);
const SCAN_DIRS = ["app", "components", "hooks", "lib"];
const SANCTIONED = "lib/realtime/client/fallback-poll.ts :: setInterval";
const REALTIME_DIR = "lib/realtime/";
const KINDS = /** @type {const} */ (["refetchInterval", "setInterval"]);

/** Every non-test .ts/.tsx file under `dir`, skipping generated and dependency trees. */
function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) walk(full, out);
		else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
	}
	return out;
}

/** The source with comment-only lines blanked (prose that names `setInterval(` is not a timer). */
function codeLines(source) {
	return source
		.split("\n")
		.map((line) => (/^\s*(\/\/|\/\*|\*)/.test(line) ? "" : line))
		.join("\n");
}

/** How many of each kind one source file contains. */
export function countPolls(source) {
	const code = codeLines(source);
	return {
		refetchInterval: [...code.matchAll(/\brefetchInterval\s*:(?!\s*false\b)/g)].length,
		setInterval: [...code.matchAll(/\bsetInterval\s*\(/g)].length,
	};
}

/** `{ "<file> :: <kind>": count }` over the console. */
function scan() {
	const found = {};
	for (const dir of SCAN_DIRS) {
		for (const file of walk(join(CONSOLE, dir))) {
			const rel = relative(CONSOLE, file);
			const counts = countPolls(readFileSync(file, "utf8"));
			for (const kind of KINDS) if (counts[kind] > 0) found[`${rel} :: ${kind}`] = counts[kind];
		}
	}
	return found;
}

/**
 * Every rule, over plain data, so the self-test can drive it. Returns the list of failures.
 * `base` is the base branch's ledger, or null when it has none yet.
 */
export function verify(found, ledger, base) {
	const errors = [];
	const sanctioned = ledger.sanctioned ?? {};
	const timers = ledger.timers ?? {};
	const polls = ledger.polls ?? {};
	const sections = { sanctioned, timers, polls };

	const sanctionedKeys = Object.keys(sanctioned);
	if (sanctionedKeys.length !== 1 || sanctionedKeys[0] !== SANCTIONED) {
		errors.push(`the ledger must sanction exactly one poll, "${SANCTIONED}" — found ${JSON.stringify(sanctionedKeys)}`);
	}

	const filed = new Map();
	for (const [name, section] of Object.entries(sections)) {
		for (const [key, entry] of Object.entries(section)) {
			if (filed.has(key)) errors.push(`${key} is filed twice (${filed.get(key)} and ${name})`);
			filed.set(key, name);
			if (!Number.isInteger(entry?.count) || entry.count < 1) errors.push(`${key}: count must be a positive integer`);
			if (name === "polls") {
				if (typeof entry?.lifts !== "string" || !/^(#\d+|unassigned)$/.test(entry.lifts)) {
					errors.push(`${key}: a poll names the lane that lifts it — "lifts": "#NNNN" (or "unassigned")`);
				}
				if (key.startsWith(REALTIME_DIR)) {
					errors.push(`${key}: no poll under ${REALTIME_DIR} — the fallback poll is the only one the bus may run`);
				}
			} else if (typeof entry?.reason !== "string" || entry.reason.trim().length < 12 || /^todo\b/i.test(entry.reason.trim())) {
				errors.push(`${key}: a ${name === "timers" ? "timer" : "sanctioned poll"} states its "reason"`);
			}
			if (name === "timers" && key.endsWith(":: refetchInterval")) {
				errors.push(`${key}: a refetchInterval is a data poll by definition — it cannot be filed as a timer`);
			}
		}
	}

	for (const [key, count] of Object.entries(found)) {
		const section = filed.get(key);
		if (!section) {
			errors.push(
				`new ${key.endsWith("refetchInterval") ? "poll" : "interval"}: ${key} (×${count})\n    ` +
					"subscribe the topic instead (lib/query/topics.ts TOPIC_KEYS) and delete the poll; a REAL timer (a heartbeat, a clock) is filed under `timers` with its reason.",
			);
			continue;
		}
		const want = sections[section][key].count;
		if (count !== want) {
			errors.push(
				`${key}: the tree has ${count}, the ledger says ${want}\n    ` +
					(count < want ? "set the ledger's count to the tree's (it only shrinks)." : "a new interval in a ledgered file is still a new interval."),
			);
		}
	}
	for (const key of filed.keys()) {
		if (!(key in found)) {
			errors.push(`ledger entry no longer found: ${key}\n    the poll or timer is gone — delete its entry from ${LEDGER_REL} in the same PR.`);
		}
	}

	if (base) {
		const basePolls = base.polls ?? {};
		for (const [key, entry] of Object.entries(polls)) {
			const before = basePolls[key]?.count;
			if (before === undefined) errors.push(`${key}: a poll the base branch's ledger does not have — polls only shrink`);
			else if (entry.count > before) errors.push(`${key}: ${before} → ${entry.count} — polls only shrink`);
		}
		for (const key of Object.keys(basePolls)) {
			if (key in timers || key in sanctioned) {
				errors.push(`${key}: a poll on the base branch re-filed as ${key in timers ? "a timer" : "sanctioned"} — remove the poll instead`);
			}
		}
	}
	return errors;
}

/** The base branch's ledger; null when the ref exists but has no ledger yet. Throws when the ref is unreadable. */
function readBase(ref) {
	try {
		execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: ROOT, stdio: "pipe" });
	} catch {
		throw new Error(
			`cannot read the base ref "${ref}" — the shrink-only rule has nothing to compare against. ` +
				"In a shallow checkout run `git fetch --no-tags --depth=1 origin +refs/heads/dev:refs/remotes/origin/dev` first.",
		);
	}
	try {
		return JSON.parse(execFileSync("git", ["show", `${ref}:${LEDGER_REL}`], { cwd: ROOT, stdio: "pipe" }).toString());
	} catch {
		return null;
	}
}

/** Fixtures for the matcher and the rules: each must be classified as stated, or the instrument is blind. */
function selfTest() {
	const matcher = [
		["useQuery({ queryKey: k, refetchInterval: 5_000 })", { refetchInterval: 1, setInterval: 0 }],
		["useQuery({ refetchInterval: false })", { refetchInterval: 0, setInterval: 0 }],
		["useQuery({ refetchInterval: (q) => (q.state.data ? 5000 : false) })", { refetchInterval: 1, setInterval: 0 }],
		["const t = setInterval(() => tick(), 1000);\nclearInterval(t);", { refetchInterval: 0, setInterval: 1 }],
		["window.setInterval(f, 10); globalThis.__x = setInterval (g, 5);", { refetchInterval: 0, setInterval: 2 }],
		["clearInterval(handle);", { refetchInterval: 0, setInterval: 0 }],
		["// a comment that says setInterval( and refetchInterval: 5\n * setInterval(x)", { refetchInterval: 0, setInterval: 0 }],
	];
	let failed = 0;
	for (const [src, want] of matcher) {
		const got = countPolls(src);
		if (JSON.stringify(got) !== JSON.stringify(want)) {
			failed++;
			console.error(`✗ self-test (matcher): expected ${JSON.stringify(want)}, got ${JSON.stringify(got)} for:\n${src}`);
		}
	}

	const reason = "an SSE heartbeat, not a data read";
	const good = {
		sanctioned: { [SANCTIONED]: { count: 1, reason: "the one fallback poll while the stream is down" } },
		timers: { "a.ts :: setInterval": { count: 1, reason } },
		polls: { "b.ts :: refetchInterval": { count: 2, lifts: "#1" } },
	};
	const foundGood = { [SANCTIONED]: 1, "a.ts :: setInterval": 1, "b.ts :: refetchInterval": 2 };
	const clone = (v) => JSON.parse(JSON.stringify(v));
	const rules = [
		["a consistent ledger passes", foundGood, good, good, 0],
		["an unledgered match fails", { ...foundGood, "c.ts :: setInterval": 1 }, good, good, 1],
		["a stale entry fails", { [SANCTIONED]: 1, "a.ts :: setInterval": 1 }, good, good, 1],
		["a count that shrank in the tree fails until the ledger follows", { ...foundGood, "b.ts :: refetchInterval": 1 }, good, good, 1],
		["a count that grew fails", { ...foundGood, "a.ts :: setInterval": 2 }, good, good, 1],
		["a poll that grew against the base fails", foundGood, good, (() => { const b = clone(good); b.polls["b.ts :: refetchInterval"].count = 1; return b; })(), 1],
		["a new poll key against the base fails", foundGood, good, (() => { const b = clone(good); b.polls = {}; return b; })(), 1],
		["a poll re-filed as a timer fails", { [SANCTIONED]: 1, "a.ts :: setInterval": 1, "b.ts :: setInterval": 1 }, (() => { const l = clone(good); l.timers["b.ts :: setInterval"] = { count: 1, reason }; delete l.polls["b.ts :: refetchInterval"]; return l; })(), (() => { const b = clone(good); b.polls = { "b.ts :: setInterval": { count: 1, lifts: "#1" } }; return b; })(), 1],
		["a refetchInterval filed as a timer fails", foundGood, (() => { const l = clone(good); l.timers["b.ts :: refetchInterval"] = { count: 2, reason }; delete l.polls["b.ts :: refetchInterval"]; return l; })(), null, 1],
		["a poll under lib/realtime fails", { ...foundGood, "lib/realtime/x.ts :: setInterval": 1 }, (() => { const l = clone(good); l.polls["lib/realtime/x.ts :: setInterval"] = { count: 1, lifts: "#1" }; return l; })(), null, 1],
		["a second sanctioned entry fails", foundGood, (() => { const l = clone(good); l.sanctioned["a.ts :: setInterval"] = l.timers["a.ts :: setInterval"]; delete l.timers["a.ts :: setInterval"]; return l; })(), null, 1],
		["a timer without a reason fails", foundGood, (() => { const l = clone(good); l.timers["a.ts :: setInterval"].reason = "TODO"; return l; })(), null, 1],
		["a poll without a lane fails", foundGood, (() => { const l = clone(good); delete l.polls["b.ts :: refetchInterval"].lifts; return l; })(), null, 1],
	];
	for (const [name, found, ledger, base, wantErrors] of rules) {
		const errors = verify(found, ledger, base);
		if (errors.length !== wantErrors) {
			failed++;
			console.error(`✗ self-test (rules): ${name} — expected ${wantErrors} failure(s), got ${errors.length}:\n  ${errors.join("\n  ")}`);
		}
	}

	const tree = scan();
	if (Object.keys(tree).length === 0 || !(SANCTIONED in tree)) {
		failed++;
		console.error("✗ self-test: the console scan found no intervals, or not the sanctioned fallback poll — the instrument is blind.");
	}
	if (failed) process.exit(1);
	console.log(`✓ check-no-polling self-test: ${matcher.length} matcher fixtures and ${rules.length} rule fixtures classified correctly.`);
}

/** Seeds or refreshes the ledger from the tree, keeping every stated reason and lane. */
function write(found) {
	let prior = { sanctioned: {}, timers: {}, polls: {} };
	try {
		prior = JSON.parse(readFileSync(LEDGER, "utf8"));
	} catch {
		/* first seed */
	}
	const next = { sanctioned: {}, timers: {}, polls: {} };
	for (const [key, count] of Object.entries(found).sort(([a], [b]) => a.localeCompare(b))) {
		const section = ["sanctioned", "timers", "polls"].find((s) => prior[s]?.[key]) ?? (key === SANCTIONED ? "sanctioned" : "polls");
		const entry = prior[section]?.[key] ?? (section === "polls" ? { lifts: "unassigned" } : { reason: "TODO" });
		next[section][key] = { ...entry, count };
	}
	writeFileSync(LEDGER, `${JSON.stringify(next, null, "\t")}\n`);
	console.log(`wrote ${Object.keys(found).length} entries to ${LEDGER_REL} — review every new "TODO" reason and "unassigned" lane.`);
}

function main() {
	const args = process.argv.slice(2);
	if (args.includes("--self-test")) return selfTest();
	const found = scan();
	if (args.includes("--write")) return write(found);
	const baseRef = args.find((a) => a.startsWith("--base="))?.slice("--base=".length) ?? "origin/dev";
	const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
	let base;
	try {
		base = readBase(baseRef);
	} catch (error) {
		console.error(`✗ check-no-polling: ${error.message}`);
		process.exit(1);
	}
	const errors = verify(found, ledger, base);
	if (errors.length) {
		for (const e of errors) console.error(`✗ ${e}`);
		process.exit(1);
	}
	const polls = Object.values(ledger.polls ?? {}).reduce((n, e) => n + e.count, 0);
	const timers = Object.values(ledger.timers ?? {}).reduce((n, e) => n + e.count, 0);
	console.log(
		`✓ check-no-polling: ${polls} data polls left (they only shrink), ${timers} timers with stated reasons, 1 sanctioned fallback poll` +
			(base ? ` — compared with ${baseRef}.` : ` — ${baseRef} has no ledger yet, so nothing to shrink against.`),
	);
}

main();
