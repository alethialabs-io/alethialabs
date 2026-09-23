// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ci-demand — how much CI this repo ASKS FOR, and how long it waits to get it.
//
// ── WHY THIS EXISTS ──
//
// CI was the throughput ceiling for about two months and nobody could say why, because the two
// numbers that answer it were never being taken. Measured 2026-09-03 over 500 runs / 6h24m and
// 1,396 jobs:
//
//   job execution   1,802 minutes   median  1.9 min
//   job WAITING     5,376 minutes   median 17.7 min
//
// Three quarters of CI wall-clock is waiting for a runner. So the currency is **runner slots
// REQUESTED, not minutes consumed** — a five-second job that waits twenty minutes holds a slot for
// twenty minutes, and a workflow that costs nothing to run still costs a slot to schedule. Every
// intuition built on "minutes" prices this repo's CI wrongly.
//
// The composition of that demand, same sample:
//
//   feature-branch PRs        236  47%   the real work
//   Mergify speculative       148  29%
//   promotion PR (head=dev)   112  22%   re-validating a promotion nobody was promoting
//   cancelled, of all runs     77  15%   started, took a slot, thrown away
//
// ── THE ONE NUMBER, AND TWO WRONG ONES I TRIED FIRST ──
//
// `rootWaits` — for every job that was READY THE MOMENT THE RUN WAS CREATED, how long it waited for
// a runner. Pooled across the sample, its percentiles are the capacity signal.
//
// "Ready at creation" is derived structurally, not from a list of job names: a job with `needs:` is
// created when its DEPENDENCY FINISHES, so root jobs are exactly those sharing the run's earliest
// `created_at`. A hard-coded list of "jobs with no `needs:`" would be a copy of ci.yml that goes
// stale silently, and this file would then report a confident number about the wrong set.
//
// TWO EARLIER DEFINITIONS WERE WRONG, and the real data caught both — recorded because each looked
// obviously right and each reported a HEALTHY repo:
//
//   1. "min wait across all jobs in the run" → reported 0.0 min against a measured 15-minute
//      median. A dependent job is created late and starts at once, so its ~0 wait dominated the
//      minimum. `created_at` does not mean the same thing for every job in a run.
//   2. "min wait across ROOT jobs" → still 0.0. GitHub grants SOME runners immediately and rations
//      the rest, so every run has one root job that started instantly while its siblings waited
//      15-36 minutes. Time-to-FIRST-runner is not the constraint; time-to-ENOUGH-runners is.
//
// Hence pooling every root job's wait, plus `runFullyDispatched` — the MAX root wait per run, which
// is when the run actually became useful. A run is not running because one job of twenty is.
//
// On 2026-09-03 the pooled distribution was bimodal: a third of root jobs started within seconds,
// the rest waited 4-36 minutes. Bimodal is the signature of demand-driven throttling — the pool is
// not slow, it is rationed, and the ration improves when total demand falls. That is the whole
// theory of the cuts this instrument exists to check.
//
// ── WHAT IT REFUSES TO DO ──
//
// Report a clean number from no data. An empty sample, or one with no timing at all, EXITS
// NON-ZERO. This repo's dominant defect is a guard whose "nothing found" branch is indistinguishable
// from "nothing wrong", and an instrument built to measure that class must not join it.
//
//   node scripts/ci/ci-demand.mjs --input runs-with-jobs.json
//   node scripts/ci/ci-demand.mjs --self-test
//
// The input is a JSON array of {id, name, event, head_branch, conclusion, created_at, jobs}, where
// `jobs` is an array of {conclusion, created_at, started_at} — or **null**, meaning the collector
// could not read that run. `.github/workflows/workflow-health.yml` collects it; keeping fetch out of
// this file is what makes the classifier testable without a network.
//
// ── THREE WAYS TO HAVE NO WAIT, AND THEY ARE NOT THE SAME NUMBER (#4934) ──
//
// A run contributes no wait for three reasons that a single counter cannot tell apart, and the
// difference is the whole reading:
//
//   never got a runner    it asked and was starved              — the WORST case
//   nothing to dispatch   every job was `skipped`               — it asked for nothing
//   could not be read     the jobs API call failed              — we did not look
//
// Until #4934 all three collapsed into `neverDispatched`, and the third did not even reach this
// file: the collector's `|| echo '[]'` turned a failed API call into "this run had no jobs", so a
// partial collection outage biased the sample downward with no signal at all. They are now three
// counters, and `render` prints all three every time, including the zeros — "0 could not be read"
// is a result, and its absence is not.
//
// `skipped` is the one that was measured. Sampled 2026-09-23 over the same 60 runs the collector
// takes: 266 jobs, of which 89 had `started_at == created_at` and **all 89 were `skipped`** — not
// one executed job in the sample had a zero wait. Six runs were entirely skipped, and this file
// reported all six as "never got a runner": a 7× overstatement of starvation (7 reported, 1 real)
// applying the worst-case label to runs that never asked for a runner at all.
//
// ── COMPARABILITY WITH THE PUBLISHED FIGURES: CHECKED, NOT ASSUMED ──
//
// The 2026-09-03 numbers quoted at the top were produced under the old timestamp predicate, so
// #4934 ran both pipelines over one identical 60-run fetch before changing anything. The wait
// distribution came out THE SAME TO EVERY DIGIT — 141 root jobs, median 0.3 min, p90 4.2, max 8.3,
// 38% instant, fully-dispatched 0.3 / 2.7 — because on real data `started_at == created_at` and
// `conclusion == "skipped"` selected the same 89 jobs. **The published waiting/executing/median
// figures remain comparable across this change.**
//
// ONE REPORTED NUMBER DOES MOVE, and it moves because it was wrong: "never got a runner" read 7 on
// that sample and now reads 1, with the other 6 named as "nothing to dispatch". The old 7 was the
// sum of two unlike things. A reader comparing a nightly summary from before 2026-09-23 to one
// after must not read that drop as CI capacity improving — nothing about the repo changed, the
// counter stopped conflating starvation with runs that asked for nothing.

/** Where a run came from. The buckets are the levers — each one is fixed differently. */
export function origin(run) {
	const head = run.head_branch ?? "";
	if (run.event === "merge_group") return "speculative";
	if (run.event === "pull_request" || run.event === "pull_request_target") return "feature";
	if (run.event === "push" && head.startsWith("mergify/merge-queue/")) return "speculative";
	// A promotion PR's head IS an integration branch, so every merge into it re-fires the PR's
	// whole workflow set against a diff that matches nearly every path filter. That is how one
	// open PR became 22% of all CI.
	if (head === "dev" || head === "staging") return "promotion-pr";
	if (head === "main") return "main";
	return "feature";
}

/**
 * A job that never asked for a runner: GitHub's conclusion for one whose `if:` was false, or whose
 * `needs:` did not run. It is created and "started" without ever being dispatched, so its wait is a
 * timestamp artefact and not a measurement of anything.
 *
 * THIS REPLACED A TIMESTAMP COINCIDENCE, and the distinction is the point. The collector used to
 * exclude these with `select(.started_at != .created_at)` — right about today's data by accident,
 * wrong about what it was asking. Measured over 60 runs / 266 jobs on 2026-09-23 the two predicates
 * agreed EXACTLY (89 jobs, 89 skipped, no disagreement in either direction), which is why this
 * change does not move the published numbers. But they agree only while GitHub never dispatches a
 * real job inside one second of creating it: the moment it does, the timestamp form silently
 * discards a genuine zero wait — the metric's own best case — and reads the repo as worse than it
 * is. Asking for the conclusion asks the question we actually mean, and it cannot drift.
 *
 * It also belongs HERE and not in the collector's jq. In YAML it was a predicate with no test; in
 * this file the self-test pins it, and pins that a real sub-second wait is still counted.
 */
export function skipped(job) {
	return job.conclusion === "skipped";
}

/**
 * Wait, in seconds, for each job that was ready the moment the run was created — [] when the run
 * has no job that ever started (queued, cancelled before dispatch, every job skipped, a run the
 * collector could not read, or a fixture with no timings).
 *
 * An empty array is not a zero wait and must never be averaged as one: a run that never got a
 * runner is the worst case, not the best, and folding it in as 0 makes a starved sample read as an
 * instant one. `summarise` is what tells the four empty cases apart; this function only declines to
 * invent a number for any of them.
 */
export function rootWaits(run) {
	const timed = (run.jobs ?? []).filter((j) => j.created_at && j.started_at && !skipped(j));
	if (timed.length === 0) return [];
	const earliest = Math.min(...timed.map((j) => Date.parse(j.created_at)));
	return timed
		// One second of slack: jobs created with the run carry the same timestamp, but equality on
		// a wire format is a brittle thing to hang a metric on.
		.filter((j) => Date.parse(j.created_at) <= earliest + 1000)
		.map((j) => (Date.parse(j.started_at) - Date.parse(j.created_at)) / 1000)
		.filter((s) => Number.isFinite(s) && s >= 0);
}

/**
 * When the run actually became useful: the LAST of its ready jobs to get a runner, in seconds.
 *
 * The max, not the min — a twenty-job run with one job running is not running. This is the number
 * a person waiting on CI experiences.
 */
export function runFullyDispatched(run) {
	const w = rootWaits(run);
	return w.length === 0 ? null : Math.max(...w);
}

/** @param {number[]} xs @param {number} q */
export function percentile(xs, q) {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(Math.floor(s.length * q), s.length - 1)];
}

/**
 * Summarise a sample. THROWS on an empty or untimed sample rather than returning zeros.
 * @param {Array<object>} runs
 */
export function summarise(runs) {
	if (!Array.isArray(runs) || runs.length === 0) {
		throw new Error(
			"ci-demand: the sample is empty. That is a collection failure, not a quiet repo — " +
				"refusing to report a demand of zero.",
		);
	}
	const byOrigin = {};
	for (const r of runs) byOrigin[origin(r)] = (byOrigin[origin(r)] ?? 0) + 1;

	// `jobs: null` is the collector saying "I could not read this run". It is deliberately not
	// `jobs: []`, which says "I read it and it had none" — the two were the same value until #4934,
	// which is how an API failure got to look like an absence.
	const unreadable = runs.filter((r) => r.jobs === null).length;
	// COUNT AND REPORT rather than fail on the first one, because this step is the LAST thing in the
	// job that files the red-pipeline report and its own comment commits it to cutting only itself:
	// hard-failing on one transient 502 in 60 would trade a small bias for a guaranteed outage, and
	// that outage is exactly what #4934 cost three nights running. But a sample that is mostly holes
	// is not a sample — a number presented as covering 60 runs while describing fewer than half of
	// them is the "clean bill of health from no data" this file exists to refuse. So the reported
	// counter is the safety property and this is only the backstop, at the one line that needs no
	// guessing: the reported number would describe fewer runs than it doesn't.
	if (unreadable * 2 > runs.length) {
		throw new Error(
			`ci-demand: ${unreadable} of ${runs.length} run(s) could not be read — the jobs API call ` +
				"failed for a majority of the sample. Any wait computed from the remainder would be " +
				"reported as this repo's CI demand while describing less than half of it.",
		);
	}

	// A run whose every job was `skipped` asked for nothing, so it did not fail to get a runner —
	// it never wanted one. Counting it as never-dispatched put the metric's worst-case label on its
	// most trivial case, 6 times in 60 when measured.
	const nothingToDispatch = runs.filter(
		(r) => Array.isArray(r.jobs) && r.jobs.length > 0 && r.jobs.every(skipped),
	).length;

	// Pooled across the sample: every job that was ready when its run was created.
	const waits = runs.flatMap(rootWaits);
	const dispatched = runs.map(runFullyDispatched).filter((w) => w !== null);
	if (waits.length === 0) {
		throw new Error(
			`ci-demand: ${runs.length} run(s) and not one job with both created_at and started_at. ` +
				"The wait cannot be computed, and reporting the composition alone would read as a " +
				"clean bill of health for the number that actually matters. " +
				`(${unreadable} run(s) could not be read; ${nothingToDispatch} had every job skipped — ` +
				"if those account for the sample, this is a collection failure, not a quiet repo.)",
		);
	}
	const cancelled = runs.filter((r) => r.conclusion === "cancelled").length;
	return {
		runs: runs.length,
		byOrigin,
		cancelledPct: Math.round((cancelled * 100) / runs.length),
		// The three ways to contribute no wait, kept apart. Each is reported, and none is ever
		// folded into the wait as a zero. They are disjoint by construction — an unreadable run and
		// an all-skipped run both yield no rootWaits, so neither can also be in `dispatched` — which
		// is what keeps `neverDispatched` from going negative or double-counting.
		neverDispatched: runs.length - dispatched.length - unreadable - nothingToDispatch,
		nothingToDispatch,
		unreadable,
		rootJobs: waits.length,
		waitSeconds: {
			median: percentile(waits, 0.5),
			p90: percentile(waits, 0.9),
			max: Math.max(...waits),
			// The bimodality, made visible. A reader can otherwise not tell "most jobs start at
			// once" from "the median happens to land low", and on this repo those are the two
			// halves of the same distribution.
			instantPct: Math.round((waits.filter((w) => w <= 5).length * 100) / waits.length),
		},
		fullyDispatchedSeconds: {
			median: percentile(dispatched, 0.5),
			p90: percentile(dispatched, 0.9),
		},
	};
}

/** Render for a step summary / issue body. */
export function render(s) {
	const o = Object.entries(s.byOrigin).sort((a, b) => b[1] - a[1]);
	const lines = [
		`**${s.runs} runs** · ${s.cancelledPct}% cancelled`,
		"",
		// All three every time, zeros included. "0 could not be read" is a result; a line that
		// appears only when it is non-zero leaves its absence meaning either "none" or "not asked",
		// and this instrument's whole subject is telling those apart.
		`- **${s.neverDispatched}** asked for a runner and never got one`,
		`- **${s.nothingToDispatch}** had nothing to dispatch — every job skipped, so no wait to measure`,
		`- **${s.unreadable}** could not be read — the jobs API call failed, so these are missing, not empty`,
		"",
		"| origin | runs | share |",
		"|---|---:|---:|",
		...o.map(([k, v]) => `| ${k} | ${v} | ${Math.round((v * 100) / s.runs)}% |`),
		"",
		`**Runner wait**, across ${s.rootJobs} jobs that were ready when their run was created — the capacity signal:`,
		"",
		`- median **${(s.waitSeconds.median / 60).toFixed(1)} min** · p90 ${(s.waitSeconds.p90 / 60).toFixed(1)} min · max ${(s.waitSeconds.max / 60).toFixed(1)} min`,
		`- ${s.waitSeconds.instantPct}% got a runner within 5s — the rest are the ration`,
		`- a run had all its ready jobs running after **${(s.fullyDispatchedSeconds.median / 60).toFixed(1)} min** median · ${(s.fullyDispatchedSeconds.p90 / 60).toFixed(1)} min p90`,
	];
	return lines.join("\n");
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
function selfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond === true) console.log(`ok   - ${name}`);
		else { console.error(`FAIL - ${name} ${typeof cond === "string" ? cond : detail}`); fails++; }
	};
	const raises = (name, fn, needle) => {
		try { fn(); console.error(`FAIL - ${name} (did not throw)`); fails++; }
		catch (e) { ok(name, String(e.message).includes(needle), `message was: ${e.message}`); }
	};
	const run = (head, jobs, extra = {}) => ({ head_branch: head, jobs, ...extra });
	const job = (created, started) => ({ created_at: created, started_at: started });
	const skippedJob = (at) => ({ created_at: at, started_at: at, conclusion: "skipped" });

	ok("a merge-group run is speculative", origin(run("mergify/merge-queue/abc", [], { event: "merge_group" })) === "speculative");
	ok("...a promotion PR's head is an integration branch", origin(run("dev", [])) === "promotion-pr" && origin(run("staging", [])) === "promotion-pr");
	ok("...and anything else is feature work", origin(run("feat/x", [])) === "feature");

	// ⭐ THE DEFECT THAT SHIPPED TWICE, pinned. A job with `needs:` is created when its DEPENDENCY
	// finishes, so it starts at once and its ~0 wait says nothing about runner availability. Both
	// earlier definitions of this metric were dominated by exactly this and reported 0.0 min
	// against a measured 15-minute median.
	ok(
		"a job created LATE (it was waiting on a dependency) is not counted as a fast dispatch",
		JSON.stringify(
			rootWaits(run("f", [
				job("2026-01-01T00:00:00Z", "2026-01-01T00:20:00Z"), // root: waited 20 min
				job("2026-01-01T00:20:00Z", "2026-01-01T00:20:01Z"), // dependent: created late
			])),
		) === "[1200]",
	);
	ok(
		"...and every job created WITH the run is counted, not just the luckiest one",
		JSON.stringify(
			rootWaits(run("f", [
				job("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z"),
				job("2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z"),
			])),
		) === "[1,1800]",
	);
	// GitHub grants SOME runners at once and rations the rest, so a run with one job running is not
	// running. The max is what a person waiting on CI actually experiences.
	ok(
		"a run is fully dispatched only when its LAST ready job has a runner",
		runFullyDispatched(run("f", [
			job("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z"),
			job("2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z"),
		])) === 1800,
	);
	// A run nobody ever gave a runner to is the WORST case. Counting it as 0 would make a starved
	// sample read as an instant one — the exact inversion this file is written to prevent.
	ok("a run with no started job yields no wait, never a 0", JSON.stringify(rootWaits(run("f", [{ created_at: "x" }]))) === "[]");
	ok("...and an empty job list too", runFullyDispatched(run("f", [])) === null);

	// ⭐ #4934 · A SKIPPED job never asked for a runner, so its zero is a timestamp artefact. The
	// collector used to strip these with `select(.started_at != .created_at)` — a coincidence that
	// held for all 266 jobs measured, and holds only until GitHub dispatches something inside one
	// second. Both halves are pinned: the artefact is excluded, and a REAL zero wait survives.
	ok(
		"a SKIPPED job's zero is not counted as an instant dispatch",
		JSON.stringify(rootWaits(run("f", [
			job("2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z"),
			skippedJob("2026-01-01T00:00:00Z"),
		]))) === "[600]",
	);
	ok(
		"...but a job that REALLY started in the same second still counts — the exclusion is about the conclusion, not the clock",
		JSON.stringify(rootWaits(run("f", [
			{ created_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:00Z", conclusion: "success" },
		]))) === "[0]",
	);
	ok("...and a run the collector could not read yields no wait rather than throwing", JSON.stringify(rootWaits(run("f", null))) === "[]");

	const sample = [
		run("feat/a", [job("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z")]),
		run("dev", [job("2026-01-01T00:00:00Z", "2026-01-01T00:10:00Z")]),
		run("mergify/merge-queue/z", [job("2026-01-01T00:00:00Z", "2026-01-01T00:30:00Z")], { event: "merge_group" }),
		run("feat/b", [], { conclusion: "cancelled" }),
	];
	const s = summarise(sample);
	ok("composition is counted per origin", s.byOrigin.feature === 2 && s.byOrigin["promotion-pr"] === 1 && s.byOrigin.speculative === 1);
	ok("...cancelled share is of ALL runs", s.cancelledPct === 25);
	ok("...and a run that never got a runner is reported, not dropped silently", s.neverDispatched === 1);
	ok("the median wait ignores the never-dispatched run rather than scoring it 0", s.waitSeconds.median === 600);
	ok("...and `instantPct` separates 'started at once' from 'median happens to be low'", s.waitSeconds.instantPct === 33);

	// ⭐ #4934 · THE THREE EMPTY CASES ARE THREE COUNTERS. Before this they were one, so "we could
	// not read 6 of these" and "6 of these were starved of runners" were the same sentence — and the
	// first was not even reachable, because the collector answered an API failure with `[]`.
	const mixed = [
		run("feat/ok", [job("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z")]),
		run("feat/starved", [{ created_at: "2026-01-01T00:00:00Z" }]),
		run("feat/all-skipped", [skippedJob("2026-01-01T00:00:00Z"), skippedJob("2026-01-01T00:00:00Z")]),
		run("feat/unreadable", null),
	];
	const m = summarise(mixed);
	ok("a starved run is 'never got a runner'", m.neverDispatched === 1, `was ${m.neverDispatched}`);
	ok("...a run whose every job was skipped is NOT — it asked for nothing", m.nothingToDispatch === 1, `was ${m.nothingToDispatch}`);
	ok("...a run the collector could not read is neither — it is missing, not empty", m.unreadable === 1, `was ${m.unreadable}`);
	ok(
		"...and the four classes account for the whole sample exactly once each",
		m.neverDispatched + m.nothingToDispatch + m.unreadable + 1 === m.runs,
	);
	// The refusal. Under half unreadable is reported and survives; over half is not a sample.
	ok("a minority of unreadable runs is reported, not fatal — one 502 must not cost the night's measurement", summarise([...mixed, run("feat/ok2", [job("2026-01-01T00:00:00Z", "2026-01-01T00:02:00Z")])]).unreadable === 1);
	raises(
		"...but a MAJORITY of unreadable runs raises rather than reporting a number about runs nobody read",
		() => summarise([run("feat/ok", [job("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z")]), run("a", null), run("b", null)]),
		"could not be read",
	);

	// THE REFUSALS. Both are states that would otherwise render as a healthy repo.
	raises("an EMPTY sample raises rather than reporting zero demand", () => summarise([]), "the sample is empty");
	raises(
		"...and a sample with no timings raises rather than reporting composition alone",
		() => summarise([run("feat/a", [{ created_at: "2026-01-01T00:00:00Z" }])]),
		"not one job with both created_at and started_at",
	);

	ok("render names the capacity signal", render(s).includes("Runner wait"));
	// Zeros included, deliberately: a line that appears only when non-zero leaves its absence
	// meaning either "none" or "nobody asked", which is the ambiguity this unit exists to remove.
	const rm = render(m);
	ok(
		"...and renders the three empty cases as three distinct lines",
		rm.includes("asked for a runner and never got one") &&
			rm.includes("nothing to dispatch") &&
			rm.includes("could not be read"),
	);
	ok(
		"...printing a zero rather than omitting the line",
		render(summarise([
			run("feat/ok", [job("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z")]),
		])).includes("**0** could not be read"),
	);

	if (fails > 0) { console.error(`\nci-demand self-test: ${fails} failure(s)`); process.exit(1); }
	console.log("\nself-test: all passed");
}

if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const i = process.argv.indexOf("--input");
	if (i === -1 || !process.argv[i + 1]) {
		console.error("usage: ci-demand.mjs --input <runs-with-jobs.json> | --self-test");
		process.exit(2);
	}
	const { readFileSync } = await import("node:fs");
	console.log(render(summarise(JSON.parse(readFileSync(process.argv[i + 1], "utf8")))));
}
