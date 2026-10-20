#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// WHAT THE JOBS CHANGE TRIGGER COSTS AT COMMIT (#6115, ADR 0005 §10).
//
// NOTIFY takes a database-wide lock while the notifying transaction commits, so every commit that
// NOTIFYs is serialised against every other one. The real-time bus adds a NOTIFY to the runner's
// hottest write — `update_job_status` posting a stage — so its cost is measured here before the bus
// is trusted, not assumed:
//
//   --concurrency connections, each looping the REAL update_job_status RPC as a runner posting
//   PROCESSING with fresh metadata ('{"i":n}' — a listed column, so the trigger fires on EVERY call)
//   on its own claimed job for --duration-ms, timing each call. Three phases on the same seed:
//
//     notify+listen   trigger enabled, one LISTEN connection open on alethia_change (production)
//     notify          trigger enabled, nobody listening
//     baseline        `ALTER TABLE jobs DISABLE TRIGGER jobs_notify_change_upd`
//
//   Reported per phase: p50/p95/p99 latency and calls/s.
//
// THE GATE (spec §6.3): if notify+listen's p99 exceeds baseline's p99 by more than max(25 %, 5 ms),
// the verdict is `outbox` — the trigger should INSERT into a change_hints table drained by one loop
// instead of NOTIFYing per commit (a migration; see the spec's §1.6). Exit 1 in that case, 0 otherwise.
//
// THIS WRITES. It seeds --runners self runners and --jobs claimed jobs, toggles a trigger on a shared
// table, and deletes what it seeded at the end (the trigger is re-enabled in a `finally`). Run it ONLY
// against a throwaway database, which is why --confirm-scratch is required. --db is a credential and is
// never printed.
//
// Usage:
//   node scripts/bench-notify-commit.mjs --help
//   node scripts/bench-notify-commit.mjs --self-test
//   node scripts/bench-notify-commit.mjs --db "$SCRATCH_DATABASE_URL" --confirm-scratch \
//       [--runners 20] [--jobs 200] [--concurrency 200] [--duration-ms 60000] [--out FILE]

import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { percentile } from "./bench-realtime.mjs";

const HELP = `bench-notify-commit — the jobs change trigger's cost at commit (#6115)

  --db URL              a THROWAWAY Postgres, migrated, as a role that may ALTER TABLE jobs (required; never printed)
  --confirm-scratch     required: this seeds rows and disables a trigger while it runs
  --runners N           self runners to seed (default 20)
  --jobs N              claimed jobs to seed, spread over the runners (default 200)
  --concurrency N       connections looping update_job_status (default 200)
  --duration-ms N       how long each phase runs (default 60000)
  --out FILE            write the JSON here instead of stdout
  --self-test           check argument parsing, the percentile math and the gate, offline; exit 0/1
  --help                this text
`;

const DEFAULTS = {
	runners: 20,
	jobs: 200,
	concurrency: 200,
	"duration-ms": 60000,
};

/**
 * Parses `argv`. Returns `{ mode: "help" | "self-test" }` or `{ mode: "run", opts }`; throws an Error
 * naming the flag (never its value) on bad input.
 */
export function parseArgs(argv) {
	if (argv.includes("--help") || argv.includes("-h")) return { mode: "help" };
	if (argv.includes("--self-test")) return { mode: "self-test" };
	const opts = { ...DEFAULTS, db: undefined, out: null, "confirm-scratch": false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith("--")) throw new Error(`unexpected argument at position ${i + 1}`);
		const eq = arg.indexOf("=");
		const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
		if (name === "confirm-scratch") {
			opts["confirm-scratch"] = true;
			continue;
		}
		if (!(name in opts)) throw new Error(`unknown flag --${name}`);
		let value;
		if (eq >= 0) value = arg.slice(eq + 1);
		else {
			value = argv[i + 1];
			if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
			i += 1;
		}
		if (name in DEFAULTS) {
			const n = Number(value);
			if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
			opts[name] = n;
		} else opts[name] = value;
	}
	if (!opts.db) throw new Error("--db is required");
	if (!opts["confirm-scratch"]) {
		throw new Error("--confirm-scratch is required: this seeds rows and disables a trigger");
	}
	if (opts.jobs < opts.runners) throw new Error("--jobs must be at least --runners");
	return { mode: "run", opts };
}

/** p50/p95/p99 (ms, 0.01) and calls/s of one phase's samples. */
export function phaseStats(samples, durationMs) {
	const sorted = [...samples].sort((a, b) => a - b);
	const r = (x) => (x === null ? null : Math.round(x * 100) / 100);
	return {
		calls: sorted.length,
		perSecond: Math.round((sorted.length / durationMs) * 1000),
		p50: r(percentile(sorted, 50)),
		p95: r(percentile(sorted, 95)),
		p99: r(percentile(sorted, 99)),
	};
}

/**
 * The spec's gate: a p99 regression over baseline larger than max(25 %, 5 ms) means NOTIFY-per-commit
 * is too dear and the outbox is needed. Returns the verdict and the numbers it was taken on.
 */
export function verdict(withNotifyP99, baselineP99) {
	const allowed = Math.max(baselineP99 * 0.25, 5);
	const regression = withNotifyP99 - baselineP99;
	return {
		regressionMs: Math.round(regression * 100) / 100,
		allowedMs: Math.round(allowed * 100) / 100,
		decision: regression > allowed ? "outbox" : "notify",
	};
}

/** An error reduced to something safe to print (no connection string, no SQL parameters). */
function safeError(err) {
	if (err && typeof err === "object" && "code" in err) return `${err.name ?? "error"} ${err.code}`;
	return err instanceof Error ? err.name : "error";
}

/** The whole measurement. */
async function run(opts) {
	const require = createRequire(new URL("../apps/console/package.json", import.meta.url));
	const postgres = require("postgres");
	const sql = postgres(opts.db, { max: opts.concurrency + 2, prepare: false, idle_timeout: 5 });
	const tag = `bench-6115-${randomUUID().slice(0, 8)}`;
	const user = randomUUID();
	const runnerIds = [];
	const work = []; // { runner, hash, job }
	let listener = null;
	const result = { tag, ...DEFAULTS, ...pick(opts), startedAt: new Date().toISOString(), phases: {} };

	try {
		for (let r = 0; r < opts.runners; r++) {
			const token = randomUUID();
			const hash = createHash("sha256").update(token).digest("hex");
			const [row] = await sql`
				insert into public.runners (user_id, org_id, name, operator, provisioning, status, token_hash)
				values (${user}::uuid, ${user}::uuid, ${`${tag}-${r}`}, 'self', 'registered', 'ONLINE', ${hash})
				returning id`;
			runnerIds.push({ id: row.id, hash });
		}
		for (let j = 0; j < opts.jobs; j++) {
			const runner = runnerIds[j % runnerIds.length];
			const [row] = await sql`
				insert into public.jobs (user_id, org_id, job_type, status, runner_id, config_snapshot, started_at)
				values (${user}::uuid, ${user}::uuid, 'PLAN', 'PROCESSING', ${runner.id}::uuid, '{}'::jsonb, now())
				returning id`;
			work.push({ runner: runner.id, hash: runner.hash, job: row.id });
		}

		/** One phase: every connection loops the RPC until the deadline. */
		const phase = async () => {
			const samples = [];
			const deadline = performance.now() + opts["duration-ms"];
			let n = 0;
			await Promise.all(
				Array.from({ length: opts.concurrency }, async (_, w) => {
					const { runner, hash, job } = work[w % work.length];
					while (performance.now() < deadline) {
						const meta = JSON.stringify({ i: n++ });
						const t0 = performance.now();
						await sql`select public.update_job_status(${runner}::uuid, ${hash}, ${job}::uuid, 'PROCESSING', NULL, ${meta}::jsonb)`;
						samples.push(performance.now() - t0);
					}
				}),
			);
			return phaseStats(samples, opts["duration-ms"]);
		};

		listener = postgres(opts.db, { max: 1 });
		let heard = 0;
		await listener.listen("alethia_change", () => {
			heard += 1;
		});
		result.phases["notify+listen"] = await phase();
		result.phases["notify+listen"].noticesHeard = heard;
		await listener.end({ timeout: 1 });
		listener = null;

		result.phases.notify = await phase();

		await sql`alter table public.jobs disable trigger jobs_notify_change_upd`;
		try {
			result.phases.baseline = await phase();
		} finally {
			await sql`alter table public.jobs enable trigger jobs_notify_change_upd`;
		}

		result.gate = verdict(result.phases["notify+listen"].p99, result.phases.baseline.p99);
	} finally {
		if (listener) await listener.end({ timeout: 1 }).catch(() => {});
		const ids = runnerIds.map((r) => r.id);
		if (ids.length) {
			await sql`delete from public.jobs where runner_id = any(${ids}::uuid[])`.catch(() => {});
			await sql`delete from public.runner_usage_sessions where runner_id = any(${ids}::uuid[])`.catch(
				() => {},
			);
			await sql`delete from public.runners where id = any(${ids}::uuid[])`.catch(() => {});
		}
		await sql.end({ timeout: 2 });
	}
	result.finishedAt = new Date().toISOString();
	return result;
}

/** The numeric options, for the report (never --db). */
function pick(opts) {
	return {
		runners: opts.runners,
		jobs: opts.jobs,
		concurrency: opts.concurrency,
		"duration-ms": opts["duration-ms"],
	};
}

/** Offline checks. Exits non-zero on any failure. */
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
			return pattern.test(err.message) && !err.message.includes("SECRET");
		}
	};
	const db = "postgres://u:SECRET@h/scratch";
	const p = parseArgs(["--db", db, "--confirm-scratch"]);
	check("parses with defaults", p.mode === "run" && p.opts.concurrency === 200 && p.opts.jobs === 200);
	check("--flag=value", parseArgs([`--db=${db}`, "--confirm-scratch", "--runners=4"]).opts.runners === 4);
	check("help", parseArgs(["--help"]).mode === "help");
	check("self-test", parseArgs(["--self-test"]).mode === "self-test");
	check("refuses without --confirm-scratch", throws(() => parseArgs(["--db", db]), /confirm-scratch/));
	check("refuses without --db", throws(() => parseArgs(["--confirm-scratch"]), /--db is required/));
	check("refuses a bad count", throws(() => parseArgs(["--db", db, "--confirm-scratch", "--jobs", "-1"]), /positive integer/));
	check("refuses fewer jobs than runners", throws(() => parseArgs(["--db", db, "--confirm-scratch", "--runners", "5", "--jobs", "2"]), /at least/));
	check("refuses an unknown flag", throws(() => parseArgs(["--db", db, "--confirm-scratch", "--x", "1"]), /unknown flag/));

	const ms = [...Array(1000).keys()].map((i) => i / 10); // 0.0 … 99.9
	const s = phaseStats(ms, 2000);
	check("calls/s", s.perSecond === 500 && s.calls === 1000);
	check("p50/p95/p99 nearest-rank", s.p50 === 49.9 && s.p95 === 94.9 && s.p99 === 98.9);

	// The gate: the larger of 25 % and 5 ms.
	check("small baseline: 5 ms floor holds", verdict(9.9, 5).decision === "notify");
	check("small baseline: past 5 ms is outbox", verdict(10.1, 5).decision === "outbox");
	check("large baseline: 25 % holds", verdict(124, 100).decision === "notify");
	check("large baseline: past 25 % is outbox", verdict(126, 100).decision === "outbox");
	check("exactly at the limit is not a regression", verdict(125, 100).decision === "notify");
	check("faster with notify is fine", verdict(80, 100).decision === "notify");
	check("reports the numbers", verdict(130, 100).regressionMs === 30 && verdict(130, 100).allowedMs === 25);

	if (failures.length) {
		console.error(`bench-notify-commit self-test: ${failures.length} failure(s):\n  ${failures.join("\n  ")}`);
		process.exit(1);
	}
	console.log("bench-notify-commit self-test: ok");
}

async function main() {
	let parsed;
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`bench-notify-commit: ${err.message}\n\n${HELP}`);
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
		process.exit(result.gate?.decision === "outbox" ? 1 : 0);
	} catch (err) {
		console.error(`bench-notify-commit: failed (${safeError(err)})`);
		process.exit(1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
