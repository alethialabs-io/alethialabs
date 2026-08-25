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
 * Assess every workflow and produce the report + the issue-worthy set.
 * Pure: takes data, returns data. The caller does the network.
 * @param {{name: string, conclusions: string[]}[]} workflows
 */
export function assess(workflows) {
	const rows = workflows
		.map((w) => ({ name: w.name, state: classify(w.conclusions), conclusions: w.conclusions.slice(0, WINDOW) }))
		.sort((a, b) => {
			const rank = { unhealthy: 0, flaky: 1, healthy: 2, insufficient: 3 };
			return rank[a.state] - rank[b.state] || a.name.localeCompare(b.name);
		});
	return { rows, unhealthy: rows.filter((r) => r.state === "unhealthy"), flaky: rows.filter((r) => r.state === "flaky") };
}

/** Render the human report. Markdown, because it lands in an issue and a step summary. */
export function render({ rows, unhealthy, flaky }) {
	const out = [];
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
	console.log(`\nUNHEALTHY_COUNT=${result.unhealthy.length}`);
}
