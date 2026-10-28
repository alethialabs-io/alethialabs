#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// READS DO NOT TRAVEL AS SERVER ACTIONS (ADR 0005 D1, #6113).
//
// Next dispatches server actions ONE AT A TIME per client and as POSTs, so a TanStack `queryFn`
// that calls one queues every read on the page behind every other read and every write: the
// overview fired 14 POSTs back to back (~2.7 s), the canvas 15 (empty for 5.7 s) — finding F001.
// Reads belong on the GET read router (`lib/rpc`), called through `orpc.<domain>.<proc>`.
//
// WHAT IS MATCHED. In every console source file, the identifiers imported from
// `@/app/server/actions/**` are collected; a `queryFn:` whose expression (up to the end of its
// property) names one of them is an action-backed read. It is a SHAPE test over the import graph,
// not a grep for a word, so renaming the import does not escape it.
//
// A server component's prefetch `queryFn` that calls an action in-process is matched too. It does not
// queue (no POST), but its key is not the read router's key, so the client cannot hit it on first
// paint once that read moves to `orpc` — the F004 shape. Both halves move together.
//
// WHAT IS NOT MATCHED, stated so nobody infers coverage that is not there:
//   · reads in `useEffect` / zustand stores that call an action directly (no `queryFn`) — the
//     route-behaviour audit (#6116, B1 "no client data fetch before first paint") measures those;
//   · a `queryFn` built in another module and passed in by reference — it is matched in the module
//     that builds it, where the action import is.
//
// THE LEDGER (`apps/console/read-transport-ledger.json`) lists today's action-backed reads as
// `file :: identifier`. It fails in BOTH directions: a new entry not in the ledger is a regression;
// a ledger entry no longer found is a fixed read whose entry must be deleted in the same PR, so the
// ledger only shrinks and never outlives its subject.
//
// Usage: node scripts/check-read-transport.mjs [--write] [--self-test]

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const CONSOLE = join(ROOT, "apps/console");
const LEDGER = join(CONSOLE, "read-transport-ledger.json");
const SCAN_DIRS = ["app", "components", "hooks", "lib"];

/** Every .ts/.tsx file under `dir`, skipping generated and dependency trees. */
function walk(dir, out = []) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) walk(full, out);
		else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
	}
	return out;
}

/** Identifiers a source file imports from a server-action module. */
export function actionImports(source) {
	const names = new Set();
	const re = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+["']@\/app\/server\/actions\/[^"']+["']/g;
	for (const m of source.matchAll(re)) {
		if (m[1]) continue; // `import type { … }` cannot be called
		for (const part of m[2].split(",")) {
			const spec = part.trim();
			if (!spec || spec.startsWith("type ")) continue;
			const local = spec.split(/\s+as\s+/).pop().trim();
			if (local) names.add(local);
		}
	}
	return names;
}

/** The action identifiers each `queryFn:` in `source` calls. */
export function actionBackedReads(source) {
	const names = actionImports(source);
	if (names.size === 0) return [];
	const found = new Set();
	for (const m of source.matchAll(/queryFn\s*:/g)) {
		// The property's expression runs to the next property at the same depth; a bounded window
		// is enough for the console's queryFns (arrow bodies are a line or a short block).
		const window = source.slice(m.index, m.index + 400);
		for (const name of names) {
			if (new RegExp(`\\b${name}\\s*\\(`).test(window) || new RegExp(`queryFn\\s*:\\s*${name}\\b`).test(window)) {
				found.add(name);
			}
		}
	}
	return [...found].sort();
}

/** `file :: identifier` for every action-backed read in the console. */
function scan() {
	const entries = [];
	for (const dir of SCAN_DIRS) {
		for (const file of walk(join(CONSOLE, dir))) {
			const rel = relative(CONSOLE, file);
			for (const name of actionBackedReads(readFileSync(file, "utf8"))) entries.push(`${rel} :: ${name}`);
		}
	}
	return entries.sort();
}

/**
 * The two populations the matcher reads, counted over the walked tree: files importing a callable
 * from a server-action module, and `queryFn:` sites. A finding needs both in one file, so the probe
 * asks for each: either at zero is the walk, the import pattern or the queryFn pattern gone blind.
 */
function population() {
	let importing = 0;
	let queryFnSites = 0;
	for (const dir of SCAN_DIRS) {
		for (const file of walk(join(CONSOLE, dir))) {
			const source = readFileSync(file, "utf8");
			if (actionImports(source).size > 0) importing++;
			queryFnSites += [...source.matchAll(/queryFn\s*:/g)].length;
		}
	}
	return { importing, queryFnSites };
}

/** Fixtures for the matcher: each must be classified as stated, or the instrument is blind. */
function selfTest() {
	const cases = [
		[`import { getJobs } from "@/app/server/actions/jobs";\nuseQuery({ queryKey: k, queryFn: () => getJobs() })`, ["getJobs"]],
		[`import { getJobs as load } from "@/app/server/actions/jobs";\nuseQuery({ queryFn: load })`, ["load"]],
		[`import type { JobsQuery } from "@/app/server/actions/jobs";\nuseQuery({ queryFn: () => fetchIt() })`, []],
		[`import { rerunJob } from "@/app/server/actions/jobs";\nconst m = useMutation({ mutationFn: rerunJob })`, []],
		[`import { orpc } from "@/lib/rpc/client";\nuseQuery(orpc.jobs.page.queryOptions({ input }))`, []],
	];
	let failed = 0;
	for (const [src, want] of cases) {
		const got = actionBackedReads(src);
		if (JSON.stringify(got) !== JSON.stringify(want)) {
			failed++;
			console.error(`✗ self-test: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)} for:\n${src}`);
		}
	}
	// THE BLINDNESS PROBE asks about the population the matcher reads, not about what it finds. It
	// used to fail on zero action-backed READS — a sound question while reads remained, and a wrong one
	// once the programme finished: #6129 moved the last ten onto the read router, which is the state
	// this ratchet exists to reach, and a probe that fails on its goal can only be "fixed" by putting
	// a read back. The console's WRITES are still server actions (ADR 0005 D4), so a scan that sees
	// no file importing one is the walk or the import pattern gone blind — and the fixtures above keep
	// the queryFn half honest.
	const { importing, queryFnSites } = population();
	if (importing === 0) {
		failed++;
		console.error("✗ self-test: the console scan found ZERO files importing a server action — the walk or the import pattern is blind.");
	}
	// The console still has `queryFn:` sites (local reads, the agent grid, the legacy `qk` hooks); a
	// scan that finds none is reading the wrong tree or a broken pattern, not a finished programme.
	if (queryFnSites === 0) {
		failed++;
		console.error("✗ self-test: the console scan found ZERO `queryFn:` sites — the walk or the queryFn pattern is blind.");
	}
	if (failed) process.exit(1);
	console.log(`✓ check-read-transport self-test: ${cases.length} fixtures classified correctly.`);
}

function main() {
	const args = new Set(process.argv.slice(2));
	if (args.has("--self-test")) return selfTest();
	const found = scan();
	if (args.has("--write")) {
		writeFileSync(LEDGER, `${JSON.stringify({ reads: found }, null, "\t")}\n`);
		console.log(`wrote ${found.length} entries to ${relative(ROOT, LEDGER)}`);
		return;
	}
	const ledger = new Set(JSON.parse(readFileSync(LEDGER, "utf8")).reads);
	const added = found.filter((e) => !ledger.has(e));
	const gone = [...ledger].filter((e) => !found.includes(e));
	if (added.length || gone.length) {
		for (const e of added) {
			console.error(`✗ new action-backed read: ${e}\n    move it onto the read router (lib/rpc, ADR 0005 D1) — a server action as a queryFn queues every read behind every other.`);
		}
		for (const e of gone) {
			console.error(`✗ ledger entry no longer found: ${e}\n    the read moved off actions — delete this entry from apps/console/read-transport-ledger.json in the same PR.`);
		}
		process.exit(1);
	}
	console.log(`✓ check-read-transport: ${found.length} action-backed reads remain, all in the ledger (it only shrinks).`);
}

main();
