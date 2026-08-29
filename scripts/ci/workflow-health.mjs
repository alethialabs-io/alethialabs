#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// Which workflows are red, and have been red for a while.
//
// WHY THIS EXISTS. On 2026-08-24 a sweep of every workflow's last three runs found FIVE red
// pipelines, four of them red on EVERY run, and not one had been noticed:
//
//   deploy-console        failure x3   production had not deployed for four days
//   posthog-error-issues  failure x3   the same expired key — so the surface that reports
//                                      runtime errors was down at the same time
//   release-cli           failure x3   red on every SUCCESSFUL publish
//   e2e-nightly           failure x3   four clouds "red" on nights that never touched a cloud
//   programme             failure      403 on push; its own staleness rule reds CI for
//                                      everyone about a week later
//
// Every one of them was found by asking GitHub a question nobody was asking. That is the entire
// content of this script: ask it daily, and put the answer somewhere a human reads.
//
// It deliberately does NOT fail the job. A red workflow that nobody notices is the problem being
// solved — adding a sixth red workflow to the pile would be a joke at its own expense. It opens or
// updates ONE title-deduped issue, which is the mechanism this repo already uses for the nightly
// rollup, and which demonstrably reaches someone.
//
//   node scripts/ci/workflow-health.mjs --input runs.json
//   node scripts/ci/workflow-health.mjs --self-test

/** A workflow is UNHEALTHY when every one of its last `window` runs failed. */
export const WINDOW = 3;

/** Conclusions that mean "this run did not succeed". `skipped`/`cancelled` are neither. */
const BAD = new Set(["failure", "timed_out", "startup_failure"]);
const GOOD = new Set(["success"]);

/**
 * Classify one workflow from its recent run conclusions, newest first.
 * @param {string[]} conclusions newest-first list, may be shorter than WINDOW
 * @returns {"unhealthy"|"flaky"|"healthy"|"insufficient"}
 */
export function classify(conclusions) {
	// Only decided runs carry signal. A workflow that has only ever been skipped says nothing.
	const decided = conclusions.filter((c) => BAD.has(c) || GOOD.has(c));
	if (decided.length < WINDOW) return "insufficient";
	const window = decided.slice(0, WINDOW);
	if (window.every((c) => BAD.has(c))) return "unhealthy";
	if (window.some((c) => BAD.has(c))) return "flaky";
	return "healthy";
}

/**
 * A RUN-level conclusion cannot see a job that never ran (#2506).
 *
 * `e2e-ai-nightly` gates its only substantive job on a secret being present. Without the key,
 * `preflight` succeeds, `e2e-live` is skipped, and the RUN concludes `success` — so `classify`
 * above answers "healthy", correctly and uselessly. The pipeline is green because it did nothing.
 *
 * The run conclusion is the wrong altitude, and no amount of care at that altitude fixes it. So a
 * workflow may DECLARE which job carries its meaning, and this asks whether that job actually ran:
 *
 *     env:
 *       WORKFLOW_HEALTH_SUBSTANTIVE_JOB: "E2E (browser · real model)"
 *
 * Undeclared workflows are judged exactly as before. That is deliberate — 35 workflows have
 * legitimately-conditional jobs, and a rule that flagged all of them would be triaged into silence
 * within a week.
 *
 * THE DECLARATION IS A NAME, AND NAMES DRIFT. If a job is renamed and the marker is not, the link
 * breaks — and a broken link that reports "healthy" would be this very defect wearing the costume
 * of its own fix. So a declaration that matches NO job in any observed run is `misdeclared`, which
 * reports at the top of the report rather than quietly passing.
 *
 * @param {{substantiveJob?: string, substantive?: string[], conclusions: string[]}} w
 *   `substantive[i]` is "ran" | "skipped" | "absent", aligned with `conclusions[i]`.
 * @returns {"vacuous"|"misdeclared"|null} null when the question does not apply.
 */
export function substantiveVerdict(w) {
	if (!w.substantiveJob) return null;
	const states = w.substantive ?? [];
	if (states.length === 0) return null;
	// Never seen, in any run we looked at: the marker names a job that does not exist under that
	// name. Reported, never inferred away — the alternative is a check that silently stopped asking.
	if (states.every((s) => s === "absent")) return "misdeclared";
	// Pair each state with its run's conclusion, keep the decided ones, and judge that window.
	const paired = w.conclusions
		.map((c, i) => ({ c, s: states[i] ?? "absent" }))
		.filter((p) => BAD.has(p.c) || GOOD.has(p.c))
		.slice(0, WINDOW);
	if (paired.length < WINDOW) return null;
	// A red run is already reported by `classify`, and its substantive job may well have been
	// skipped BECAUSE something upstream failed. Vacuity is only interesting on a GREEN run.
	if (!paired.every((p) => GOOD.has(p.c))) return null;
	if (paired.some((p) => p.s === "ran")) return null;
	// At least one observed skip, or this is indistinguishable from "we could not see".
	return paired.some((p) => p.s === "skipped") ? "vacuous" : null;
}

/**
 * Assess every workflow and produce the report + the issue-worthy set.
 * Pure: takes data, returns data. The caller does the network.
 * @param {{name: string, conclusions: string[]}[]} workflows
 */
export function assess(workflows) {
	const rows = workflows
		.map((w) => {
			const base = classify(w.conclusions);
			const sub = substantiveVerdict(w);
			// A vacuous verdict OVERRIDES healthy and only healthy. If the run conclusions are red or
			// mixed, that is the louder fact and `classify` already says it; a green-but-empty run is
			// precisely the case nothing else can see. `misdeclared` overrides regardless, because a
			// check that has silently stopped asking is worse than either answer it could have given.
			const state = sub === "misdeclared" ? "misdeclared" : sub === "vacuous" && base === "healthy" ? "vacuous" : base;
			return { name: w.name, state, conclusions: w.conclusions.slice(0, WINDOW), substantiveJob: w.substantiveJob };
		})
		.sort((a, b) => {
			const rank = { misdeclared: 0, unhealthy: 1, vacuous: 2, flaky: 3, healthy: 4, insufficient: 5 };
			return rank[a.state] - rank[b.state] || a.name.localeCompare(b.name);
		});
	return {
		rows,
		unhealthy: rows.filter((r) => r.state === "unhealthy"),
		flaky: rows.filter((r) => r.state === "flaky"),
		vacuous: rows.filter((r) => r.state === "vacuous"),
		misdeclared: rows.filter((r) => r.state === "misdeclared"),
	};
}

/** Render the human report. Markdown, because it lands in an issue and a step summary. */
export function render({ rows, unhealthy, flaky, vacuous = [], misdeclared = [] }) {
	const out = [];
	// First, because it is the one state that means THIS REPORT is not asking what it thinks it is.
	if (misdeclared.length > 0) {
		out.push(
			`**${misdeclared.length} workflow(s) declare a substantive job that no observed run contains.** ` +
				"The job was probably renamed and `WORKFLOW_HEALTH_SUBSTANTIVE_JOB` was not — until it is fixed, " +
				"those workflows are not being checked for vacuity at all.",
			"",
			"| workflow | declared job |",
			"|---|---|",
			...misdeclared.map((r) => `| \`${r.name}\` | \`${r.substantiveJob}\` |`),
			"",
		);
	}
	if (vacuous.length > 0) {
		out.push(
			`**${vacuous.length} workflow(s) are GREEN on every recent run while their substantive job never ran.** ` +
				"A green tick that skipped the only job carrying meaning reports the absence of a test as a passing one.",
			"",
			"| workflow | substantive job | last runs |",
			"|---|---|---|",
			...vacuous.map((r) => `| \`${r.name}\` | \`${r.substantiveJob}\` | ${r.conclusions.join(", ")} |`),
			"",
		);
	}
	if (unhealthy.length === 0) {
		out.push(`No workflow has failed its last ${WINDOW} runs.`);
	} else {
		out.push(
			`**${unhealthy.length} workflow(s) have failed every one of their last ${WINDOW} runs.** ` +
				`A pipeline that is red on every run cannot tell anyone about a new problem.`,
			"",
			"| workflow | last runs |",
			"|---|---|",
			...unhealthy.map((r) => `| \`${r.name}\` | ${r.conclusions.join(", ")} |`),
		);
	}
	if (flaky.length > 0) {
		out.push("", `<details><summary>${flaky.length} intermittent</summary>`, "", "| workflow | last runs |", "|---|---|",
			...flaky.map((r) => `| \`${r.name}\` | ${r.conclusions.join(", ")} |`), "", "</details>");
	}
	out.push("", `_${rows.filter((r) => r.state === "healthy").length} green · ` +
		`${rows.filter((r) => r.state === "insufficient").length} with too few decided runs to judge._`);
	return out.join("\n");
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
function selfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else { console.error(`FAIL - ${name} ${detail}`); fails++; }
	};

	ok("three failures is unhealthy", classify(["failure", "failure", "failure"]) === "unhealthy");
	ok("one success in the window is not unhealthy", classify(["failure", "success", "failure"]) === "flaky");
	ok("all green is healthy", classify(["success", "success", "success"]) === "healthy");
	ok("two runs cannot decide", classify(["failure", "failure"]) === "insufficient");

	// skipped/cancelled carry no signal — a gate-off leg must not read as a failure, which is
	// exactly the mistake e2e-nightly's own rollup was built to avoid.
	ok("skipped runs are ignored, not counted as failures",
		classify(["skipped", "failure", "failure", "failure"]) === "unhealthy");
	ok("...and a workflow that only ever skips is not judged",
		classify(["skipped", "skipped", "skipped"]) === "insufficient");
	ok("cancelled is neither good nor bad", classify(["cancelled", "success", "success", "success"]) === "healthy");
	ok("timed_out counts as a failure", classify(["timed_out", "failure", "failure"]) === "unhealthy");

	// The real shape from 2026-08-24 — the run that motivated this.
	const observed = assess([
		{ name: "deploy-console", conclusions: ["failure", "failure", "failure"] },
		{ name: "release-cli", conclusions: ["failure", "failure", "failure"] },
		{ name: "release-please", conclusions: ["failure", "success", "success"] },
		{ name: "ci", conclusions: ["success", "success", "success"] },
		{ name: "catalog-drift", conclusions: ["success"] },
	]);
	ok("the 2026-08-24 shape surfaces both dead pipelines", observed.unhealthy.length === 2,
		JSON.stringify(observed.unhealthy.map((r) => r.name)));
	ok("...and does not confuse the flake for one", observed.flaky.length === 1 && observed.flaky[0].name === "release-please");
	ok("...and does not judge a workflow with one run", observed.rows.find((r) => r.name === "catalog-drift").state === "insufficient");
	ok("unhealthy sorts first", observed.rows[0].state === "unhealthy");

	const clean = assess([{ name: "ci", conclusions: ["success", "success", "success"] }]);
	ok("a clean report says so plainly", /No workflow has failed/.test(render(clean)));
	ok("a red report names the workflow", /`deploy-console`/.test(render(observed)));

	// ── vacuity: green on every run, with the only job that matters skipped every time (#2506) ──
	const G3 = ["success", "success", "success"];
	const SUB = "E2E (browser · real model)";

	// THE REGRESSION. Run-level conclusions call this healthy, correctly and uselessly.
	ok("a green run whose substantive job always skipped is not healthy",
		substantiveVerdict({ substantiveJob: SUB, conclusions: G3, substantive: ["skipped", "skipped", "skipped"] }) === "vacuous");
	ok("...and classify alone still calls it healthy, which is why this exists",
		classify(G3) === "healthy");

	// The negatives are the whole design. A rule that fires on every conditional job would be
	// triaged into silence within a week, and 35 workflows have one.
	ok("one real execution in the window clears it",
		substantiveVerdict({ substantiveJob: SUB, conclusions: G3, substantive: ["skipped", "ran", "skipped"] }) === null);
	ok("an undeclared workflow is never judged on vacuity",
		substantiveVerdict({ conclusions: G3, substantive: ["skipped", "skipped", "skipped"] }) === null);
	ok("a declaration with no observations is not a verdict",
		substantiveVerdict({ substantiveJob: SUB, conclusions: G3, substantive: [] }) === null);
	ok("too few decided runs cannot decide",
		substantiveVerdict({ substantiveJob: SUB, conclusions: ["success", "success"], substantive: ["skipped", "skipped"] }) === null);
	// A red run's substantive job may have been skipped BECAUSE something upstream failed. That is
	// already reported as unhealthy; calling it vacuous too would double-count and misattribute.
	ok("vacuity is only asked of a GREEN window",
		substantiveVerdict({ substantiveJob: SUB, conclusions: ["failure", "failure", "failure"], substantive: ["skipped", "skipped", "skipped"] }) === null);
	// "absent" means we could not see the job at all in that run — not evidence that it skipped.
	ok("unseen is not skipped",
		substantiveVerdict({ substantiveJob: SUB, conclusions: G3, substantive: ["absent", "absent", "absent"] }) === "misdeclared");
	ok("a mix of absent and skipped still reports vacuity",
		substantiveVerdict({ substantiveJob: SUB, conclusions: G3, substantive: ["skipped", "absent", "absent"] }) === "vacuous");

	// A renamed job must not silently disconnect the check — that would be this defect wearing the
	// costume of its own fix.
	const drifted = assess([{ name: "e2e-ai-nightly", conclusions: G3, substantiveJob: "a job by no name", substantive: ["absent", "absent", "absent"] }]);
	ok("a declaration matching no job is misdeclared, not healthy", drifted.rows[0].state === "misdeclared");
	ok("...and the report says the check is not running", /not being checked for vacuity/.test(render(drifted)));
	ok("...and it sorts above everything, including unhealthy",
		assess([
			{ name: "dead", conclusions: ["failure", "failure", "failure"] },
			{ name: "drifted", conclusions: G3, substantiveJob: "gone", substantive: ["absent", "absent", "absent"] },
		]).rows[0].name === "drifted");

	const vac = assess([{ name: "e2e-ai-nightly", conclusions: G3, substantiveJob: SUB, substantive: ["skipped", "skipped", "skipped"] }]);
	ok("assess surfaces the vacuous workflow", vac.vacuous.length === 1 && vac.rows[0].state === "vacuous");
	ok("...and the report names the job that never ran", new RegExp(SUB.replace(/[()·]/g, ".")).test(render(vac)));
	ok("...and it is not counted as green", !/No workflow has failed/.test(render(vac)) || vac.vacuous.length === 1);
	// A vacuous verdict must not mask a red one.
	ok("a red workflow stays unhealthy even if its substantive job skipped",
		assess([{ name: "x", conclusions: ["failure", "failure", "failure"], substantiveJob: SUB, substantive: ["skipped", "skipped", "skipped"] }]).rows[0].state === "unhealthy");

	if (fails > 0) { console.error(`\nworkflow-health self-test: ${fails} failure(s)`); process.exit(1); }
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const i = process.argv.indexOf("--input");
	if (i === -1 || !process.argv[i + 1]) {
		console.error("usage: workflow-health.mjs --input <runs.json> | --self-test");
		process.exit(2);
	}
	const { readFileSync } = await import("node:fs");
	const workflows = JSON.parse(readFileSync(process.argv[i + 1], "utf8"));
	const result = assess(workflows);
	console.log(render(result));
	// The count goes to stdout's last line for the workflow to branch on. Still exit 0 — see the
	// header: this must not become the sixth red pipeline nobody looks at.
	//
	// IT COUNTS EVERYTHING WORTH OPENING AN ISSUE FOR, not just the red ones. It emitted
	// `unhealthy.length` alone, and the workflow gates the issue on `count != '0'` — so a report
	// whose only finding was a green-but-vacuous workflow would render the finding into a step
	// summary and stop there. A daily cron's step summary is not a channel anyone reads; that is a
	// finding with no outlet, which is the same defect this script exists to catch one level up.
	const actionable = result.unhealthy.length + result.vacuous.length + result.misdeclared.length;
	console.log(`\nACTIONABLE_COUNT=${actionable}`);
}
