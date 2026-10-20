#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// MEASURES THE CONSOLE'S CHANGE BUS UNDER N OPEN STREAMS (#6115, ADR 0005 §5 and §10).
//
// ADR 0005 priced a stream at "64 KB, conservative" — an estimate. This replaces it with a number,
// and measures the two other things the ADR left as claims: how long a committed change takes to
// reach every open tab, and whether every stream's resources come back when the tabs close.
//
//   1. BASELINE   the console process's VmRSS, three samples after it has been idle for --settle-ms.
//   2. OPEN       --streams fetch streams to /{org}/~/events, each on its OWN socket (a browser's
//                 leader tab is one connection; N of them is N connections), and wait for every
//                 `hello`. Settle, sample RSS again: ΔRSS / N is the per-stream cost.
//   3. LATENCY    --updates sequential updates of `error_message = 'bench-<i>'` on --job, which must
//                 be TERMINAL: error_message is in the trigger's column list, and a terminal job has
//                 no wake side effect (jobs_runner_wake fires only on QUEUED). For each update the
//                 clock starts BEFORE the UPDATE is sent and stops when a stream parses the hint, so
//                 every figure is an upper bound on commit→receipt (it includes the UPDATE's RTT).
//                 Reported: p50/p99 over every (update, stream) pair, and p50/p99 of the LAST stream
//                 to hear each update — the number a user on the slowest tab feels.
//   4. TEARDOWN   abort every stream, wait --teardown-ms (> the self-test's 30 s tick, which is what
//                 refreshes the counter), and read the deep /health: `loops[realtime-bus].lastResult
//                 .streams` must be 0 and RSS must be back within 10 % of baseline.
//
// Output is one JSON document on stdout (or --out). Run it three times on a STANDALONE build: behind
// caddy:2 with deploy/prod/Caddyfile, with deploy/prod/Caddyfile.tunnel, and through the env's
// public tunnel. A Turbopack dev server is not the product and its RSS means nothing here.
//
// SECRETS. --cookie, --health-secret and --db are credentials. They are used, never printed: the
// JSON echoes the base URL and the org slug only, and an error message is reduced to its class and
// HTTP status before it is shown.
//
// Usage:
//   node scripts/bench-realtime.mjs --help
//   node scripts/bench-realtime.mjs --self-test
//   node scripts/bench-realtime.mjs --base https://host --org acme --cookie "$COOKIE" \
//       --pid 1234 --db "$DATABASE_URL" --job <uuid> --health-secret "$CRON_SECRET" [--streams 1000]

import http from "node:http";
import https from "node:https";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

const HELP = `bench-realtime — the change bus under N open streams (#6115)

  --base URL            console origin, e.g. https://console.example (required)
  --org SLUG            org slug the streams open under; "~" for the personal scope (required)
  --cookie STRING       a signed-in session's Cookie header (required; never printed)
  --pid N               the console server's process id, for /proc/N/status VmRSS (required)
  --db URL              Postgres URL that may UPDATE public.jobs (required; never printed)
  --job UUID            a TERMINAL job visible to that session (required)
  --health-secret S     ALETHIA_CRON_SECRET, for the deep /health document (required; never printed)
  --streams N           streams to open (default 1000)
  --updates N           sequential updates to time (default 500)
  --settle-ms N         idle wait before each RSS sample (default 30000)
  --teardown-ms N       wait after closing every stream (default 35000; must exceed the 30 s self-test)
  --hint-timeout-ms N   how long one update may take to reach every stream (default 10000)
  --out FILE            write the JSON here instead of stdout
  --self-test           check argument parsing and the percentile math, offline; exit 0/1
  --help                this text
`;

/** Every flag this script takes, with its default (undefined = required). */
const SPEC = {
	base: undefined,
	org: undefined,
	cookie: undefined,
	pid: undefined,
	db: undefined,
	job: undefined,
	"health-secret": undefined,
	streams: "1000",
	updates: "500",
	"settle-ms": "30000",
	"teardown-ms": "35000",
	"hint-timeout-ms": "10000",
	out: null,
};
const NUMERIC = ["pid", "streams", "updates", "settle-ms", "teardown-ms", "hint-timeout-ms"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses `argv` against {@link SPEC}. Returns `{ mode: "help" | "self-test" }`, or `{ mode: "run",
 * opts }`, or throws an Error whose message names the flag (and never its value).
 */
export function parseArgs(argv) {
	if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
	if (argv.includes("--self-test")) return { mode: "self-test" };
	const raw = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) throw new Error(`unexpected argument at position ${i + 1}`);
		const eq = arg.indexOf("=");
		const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
		if (!(name in SPEC)) throw new Error(`unknown flag --${name}`);
		let value;
		if (eq >= 0) value = arg.slice(eq + 1);
		else {
			value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
			i += 1;
		}
		raw[name] = value;
	}
	const opts = {};
	for (const [name, def] of Object.entries(SPEC)) {
		const value = raw[name] ?? def;
		if (value === undefined) throw new Error(`--${name} is required`);
		opts[name] = value;
	}
	for (const name of NUMERIC) {
		const n = Number(opts[name]);
		if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
		opts[name] = n;
	}
	if (!UUID.test(opts.job)) throw new Error("--job must be a uuid");
	let base;
	try {
		base = new URL(opts.base);
	} catch {
		throw new Error("--base must be an absolute URL");
	}
	if (base.protocol !== "http:" && base.protocol !== "https:") {
		throw new Error("--base must be http(s)");
	}
	if (!/^(~|[a-z0-9][a-z0-9-]*)$/.test(opts.org)) throw new Error("--org must be a slug or ~");
	if (opts["teardown-ms"] <= 30_000) {
		throw new Error("--teardown-ms must exceed the self-test's 30 s tick, or the leak counter is stale");
	}
	return { mode: "run", opts };
}

/**
 * Nearest-rank percentile of an ascending-sorted array (p in (0, 100]). Null for an empty array.
 * Nearest-rank, not interpolated, so every reported figure is a latency that was actually observed.
 */
export function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** p50/p99/max/count of an unsorted sample, in ms rounded to 0.1. */
export function summarize(samples) {
	const sorted = [...samples].sort((a, b) => a - b);
	const r = (x) => (x === null ? null : Math.round(x * 10) / 10);
	return {
		count: sorted.length,
		p50: r(percentile(sorted, 50)),
		p99: r(percentile(sorted, 99)),
		max: r(sorted.at(-1) ?? null),
	};
}

/** Extracts every complete SSE event from `buffer`; returns [events, rest]. */
export function parseSse(buffer) {
	const events = [];
	let rest = buffer;
	let at;
	while ((at = rest.indexOf("\n\n")) >= 0) {
		const block = rest.slice(0, at);
		rest = rest.slice(at + 2);
		const event = { event: "message", data: "", id: null };
		for (const line of block.split("\n")) {
			if (line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon < 0 ? line : line.slice(0, colon);
			const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
			if (field === "event") event.event = value;
			else if (field === "data") event.data += value;
			else if (field === "id") event.id = value;
		}
		if (block.split("\n").every((l) => l.startsWith(":"))) continue; // heartbeat
		events.push(event);
	}
	return [events, rest];
}

/** An error reduced to what is safe to print. */
function safeError(err) {
	if (err && typeof err === "object" && "status" in err) return `HTTP ${err.status}`;
	return err instanceof Error ? err.name : "error";
}

/** VmRSS of `pid` in KB (Linux). */
function rssKb(pid) {
	const status = readFileSync(`/proc/${pid}/status`, "utf8");
	const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
	if (!m) throw new Error("VmRSS not found");
	return Number(m[1]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Three RSS samples 2 s apart after `settleMs` of quiet; returns their median. */
async function sampleRss(pid, settleMs) {
	await sleep(settleMs);
	const s = [];
	for (let i = 0; i < 3; i++) {
		s.push(rssKb(pid));
		if (i < 2) await sleep(2000);
	}
	return s.sort((a, b) => a - b)[1];
}

/** Opens one stream on its own socket. Resolves once `hello` has arrived. */
function openStream(opts, onHint) {
	const url = new URL(`/${opts.org}/~/events`, opts.base);
	const lib = url.protocol === "https:" ? https : http;
	return new Promise((resolve, reject) => {
		const req = lib.request(url, {
			method: "GET",
			agent: false, // one socket per stream
			headers: { cookie: opts.cookie, accept: "text/event-stream" },
		});
		let buffer = "";
		let greeted = false;
		req.on("response", (res) => {
			if (res.statusCode !== 200) {
				res.resume();
				reject(Object.assign(new Error("stream refused"), { status: res.statusCode }));
				return;
			}
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				const [events, rest] = parseSse(buffer + chunk);
				buffer = rest;
				for (const e of events) {
					if (e.event === "hello" && !greeted) {
						greeted = true;
						resolve({ close: () => req.destroy() });
					} else if (e.event === "hint") onHint(e.data, performance.now());
				}
			});
		});
		req.on("error", (err) => {
			if (!greeted) reject(err);
		});
		req.end();
	});
}

/** The deep /health document's realtime-bus loop report. */
async function busLoop(opts) {
	const res = await fetch(new URL("/api/health", opts.base), {
		headers: { authorization: `Bearer ${opts["health-secret"]}` },
	});
	if (!res.ok && res.status !== 503) throw Object.assign(new Error("health"), { status: res.status });
	const doc = await res.json();
	return (doc.loops ?? []).find((l) => l.id === "realtime-bus") ?? null;
}

/** The whole measurement. */
async function run(opts) {
	const require = createRequire(new URL("../apps/console/package.json", import.meta.url));
	const postgres = require("postgres");
	const sql = postgres(opts.db, { max: 1, prepare: false });
	const result = {
		base: new URL(opts.base).origin,
		org: opts.org,
		streams: opts.streams,
		updates: opts.updates,
		startedAt: new Date().toISOString(),
	};
	const streams = [];
	try {
		const baselineKb = await sampleRss(opts.pid, opts["settle-ms"]);
		result.baselineRssKb = baselineKb;

		// Per update: which streams have heard it, and when.
		let current = null; // { tag, t0, heard: Map<streamIndex, ms>, done }
		for (let i = 0; i < opts.streams; i++) {
			const index = i;
			streams.push(
				await openStream(opts, (data, at) => {
					if (!current || !data.includes(opts.job) || current.heard.has(index)) return;
					current.heard.set(index, at - current.t0);
					if (current.heard.size === opts.streams) current.done();
				}),
			);
		}
		const openKb = await sampleRss(opts.pid, opts["settle-ms"]);
		result.openRssKb = openKb;
		result.perStreamKb = Math.round(((openKb - baselineKb) / opts.streams) * 10) / 10;

		const all = [];
		const slowest = [];
		let incomplete = 0;
		for (let i = 0; i < opts.updates; i++) {
			const heard = new Map();
			let done = () => {};
			const finished = new Promise((r) => (done = r));
			current = { heard, done, t0: performance.now() };
			await sql`update public.jobs set error_message = ${`bench-${i}`} where id = ${opts.job}::uuid`;
			const ok = await Promise.race([
				finished.then(() => true),
				sleep(opts["hint-timeout-ms"]).then(() => false),
			]);
			if (!ok) incomplete += 1;
			const times = [...heard.values()];
			all.push(...times);
			if (times.length) slowest.push(Math.max(...times));
			current = null;
			await sleep(20); // let the per-stream coalescing window close between updates
		}
		result.latencyMs = { allPairs: summarize(all), lastStream: summarize(slowest) };
		result.incompleteUpdates = incomplete;

		for (const s of streams) s.close();
		streams.length = 0;
		await sleep(opts["teardown-ms"]);
		const loop = await busLoop(opts);
		result.afterTeardown = {
			busStreams: loop?.lastResult?.streams ?? null,
			busStatus: loop?.status ?? null,
			rssKb: rssKb(opts.pid),
		};
		result.afterTeardown.rssWithin10pct =
			Math.abs(result.afterTeardown.rssKb - baselineKb) <= baselineKb * 0.1;
		result.pass =
			result.afterTeardown.busStreams === 0 && result.afterTeardown.rssWithin10pct && incomplete === 0;
	} finally {
		for (const s of streams) s.close();
		await sql.end({ timeout: 1 });
	}
	result.finishedAt = new Date().toISOString();
	return result;
}

/** Offline checks of the parsing and the math. Exits non-zero on any failure. */
function selfTest() {
	const failures = [];
	const check = (name, cond) => {
		if (!cond) failures.push(name);
	};
	const throws = (fn, pattern) => {
		try {
			fn();
			return false;
		} catch (err) {
			return pattern.test(err.message);
		}
	};
	const job = "44444444-4444-4444-8444-444444444444";
	const good = [
		"--base", "https://c.example", "--org", "acme", "--cookie", "s=SECRET", "--pid", "42",
		"--db", "postgres://u:SECRET@h/db", "--job", job, "--health-secret", "SECRET",
	];
	const parsed = parseArgs(good);
	check("parses a full command line", parsed.mode === "run" && parsed.opts.pid === 42);
	check("applies the defaults", parsed.opts.streams === 1000 && parsed.opts.updates === 500);
	check("--flag=value form", parseArgs([...good, "--streams=10"]).opts.streams === 10);
	check("help wins", parseArgs(["--help"]).mode === "help");
	check("self-test mode", parseArgs(["--self-test"]).mode === "self-test");
	check("missing required flag", throws(() => parseArgs(good.slice(2)), /--base is required/));
	check("unknown flag", throws(() => parseArgs([...good, "--nope", "1"]), /unknown flag --nope/));
	check("non-integer count", throws(() => parseArgs([...good, "--streams", "1.5"]), /positive integer/));
	check("zero count", throws(() => parseArgs([...good, "--streams", "0"]), /positive integer/));
	check("non-uuid job", throws(() => parseArgs([...good.slice(0, 10), "--job", "x", ...good.slice(12)]), /uuid/));
	check("teardown shorter than the self-test tick", throws(() => parseArgs([...good, "--teardown-ms", "30000"]), /30 s/));
	check("a flag missing its value", throws(() => parseArgs([...good, "--out"]), /needs a value/));
	// An error must never carry a secret value.
	for (const bad of [[...good, "--streams", "SECRET"], [...good.slice(0, 2), "--org", "SECRET!"]]) {
		try {
			parseArgs(bad);
			check("bad input was refused", false);
		} catch (err) {
			check("error names the flag, not the value", !err.message.includes("SECRET"));
		}
	}

	check("p50 of 1..100 is 50", percentile([...Array(100).keys()].map((i) => i + 1), 50) === 50);
	check("p99 of 1..100 is 99", percentile([...Array(100).keys()].map((i) => i + 1), 99) === 99);
	check("p99 of 1..10 is the max", percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 99) === 10);
	check("p50 of one sample is that sample", percentile([7], 50) === 7);
	// Nearest-rank rounds the rank UP: p51 of 1..10 is rank ceil(5.1) = 6, never an interpolated 5.1.
	check("p51 of 1..10 is 6 (rank rounds up)", percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 51) === 6);
	check("empty sample is null", percentile([], 50) === null);
	const s = summarize([5, 1, 3]);
	check("summarize sorts", s.p50 === 3 && s.max === 5 && s.count === 3);
	check("summarize of nothing", summarize([]).p50 === null && summarize([]).count === 0);

	const [events, rest] = parseSse(
		'retry: 3000\n\nevent: hello\ndata: {"v":1}\n\n:\n\nevent: hint\nid: 7\ndata: {"t":"jobs"}\n\nevent: hi',
	);
	check("sse: heartbeat skipped, events parsed", events.length === 3 && events[2].id === "7");
	check("sse: partial event kept", rest === "event: hi");

	if (failures.length) {
		console.error(`bench-realtime self-test: ${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
		process.exit(1);
	}
	console.log("bench-realtime self-test: ok");
}

async function main() {
	let parsed;
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`bench-realtime: ${err.message}\n\n${HELP}`);
		process.exit(2);
	}
	if (parsed.mode === "help") {
		console.log(HELP);
		return;
	}
	if (parsed.mode === "self-test") {
		selfTest();
		return;
	}
	try {
		const result = await run(parsed.opts);
		const json = JSON.stringify(result, null, 2);
		if (parsed.opts.out) writeFileSync(parsed.opts.out, `${json}\n`);
		else console.log(json);
		process.exit(result.pass ? 0 : 1);
	} catch (err) {
		console.error(`bench-realtime: failed (${safeError(err)})`);
		process.exit(1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
