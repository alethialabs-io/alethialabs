#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// check-e2e-spend-guard — one invariant, enforced:
//
//   "A SCHEDULED full-bar run may only target clouds whose apply is priced."
//
// WHY THIS EXISTS. The weekly `17 5 * * 0` full-bar cron fired ALETHIA_E2E_MAX_CONFIG=1 +
// ALETHIA_E2E_ALL_ADDONS=1 across the whole five-cloud matrix, while the pre-apply cost ceiling
// (ALETHIA_COST_CEILING_MONTHLY_USD, enforced by packages/core/provisioner/cost_ceiling.go) was
// wired for `matrix.provider == 'aws'` and nothing else. So on gcp, azure, alibaba and hetzner a
// weekly run provisioned the entire 11-kind surface with NO spend gate at all. It also bought a
// standing monthly resource on alibaba every week — `alicloud_cr_ee_instance` with
// `payment_type = "Subscription"` — and the sweep that even DETECTS a survivor only landed on
// 2026-08-11 (#2340), so earlier firings could leak one silently. Two runs (2026-08-09,
// 2026-08-16) produced #2382/#2383/#2384 and no committed proof row.
//
// The cron is gone. This guard is what stops it coming back unguarded, because removing a cron is a
// one-line edit and so is adding one. A comment asking the next author to think does not survive
// contact with a Sunday; a failing check does.
//
// ── The rules ──
//
//   R1  no cloud is both priced and exempt (a contradiction, not a belt-and-braces).
//   R2  priced ∪ exempt == the scheduled matrix, BOTH directions:
//         · a matrix cloud in neither set has no spend story at all — the hole R3 then cannot see;
//         · an exemption naming a cloud that has left the matrix is stale, and a stale exemption is
//           how a real hole hides behind a reviewed-looking list. (Adding a sixth cloud therefore
//           fails here until somebody decides its pricing story — which is the point.)
//   R3  IF any scheduled cron resolves to the full bar, THEN every scheduled-matrix cloud must be
//       PRICED. Exemptions deliberately do NOT satisfy R3: an exemption is an accepted risk on a
//       run a human chose and is watching, never on one a timer starts at 05:17 on a Sunday.
//
// Dispatches are out of scope by construction: a `workflow_dispatch` matrix is the single chosen
// provider, and a human picked it. This guard is only ever about what a TIMER may start.
//
// R3 is currently VACUOUS — there is no full-bar cron. That is the intended steady state, and the
// rule is still worth its lines: it is the tripwire on the reintroduction, and `--self-test` proves
// it fires (a fixture with the old cron and the old aws-only ceiling FAILS).
//
// Reads FULL_BAR_CRON from scripts/e2e/resolve-dimension.sh rather than retyping `17 5 * * 0`, so
// the workflow, the dimension resolver and this guard cannot disagree about which cron is which —
// the same one-deriver rule #1755 imposed on the resolver itself.
//
// Run: `node scripts/check-e2e-spend-guard.mjs` · `--self-test` (wired into ci.yml → guards)

import fs from "node:fs";

const WORKFLOW = ".github/workflows/e2e-nightly.yml";
const RESOLVER = "scripts/e2e/resolve-dimension.sh";

/**
 * Clouds whose full-bar apply is NOT priced, with the reason and the issue that would close it.
 * An entry here is an accepted risk on a DISPATCHED, watched run — never on a scheduled one (R3).
 * R2 keeps the list honest in both directions, so this cannot quietly outlive the matrix.
 * @type {Record<string, {why: string, issue: string}>}
 */
const UNPRICED_EXEMPTIONS = {
	gcp: {
		why: "No Infracost estimate has ever been produced for a gcp plan in this repo, and a ceiling with no estimate FAIL-CLOSES (cost_ceiling.go:30) — so wiring one blind converts a spend risk into a red leg on the very floor Phase 2 needs green. Price it on a watched dispatch first, then move it to PRICED.",
		issue: "#2385",
	},
	azure: {
		why: "As gcp: unproven estimate, and the ceiling fail-closes without one. Azure's e2e subscription also has a 10 vCPU Total Regional cap, so a full bar is shape-limited before it is cost-limited.",
		issue: "#2385",
	},
	alibaba: {
		why: "Infracost pricing for alicloud is unproven here, and alibaba's real full-bar risk is not the hourly rate but a PREPAID resource a ceiling cannot see: alicloud_cr_ee_instance is created with payment_type = \"Subscription\". The control that matters is the #2340 sweep failing on a survivor, not a monthly-USD ceiling.",
		issue: "#2385",
	},
	hetzner: {
		why: "Unproven estimate, and the measured cost of a hetzner full bar is cents per run (~EUR 0.02-0.10), so a monthly-USD ceiling would gate almost nothing. The account being SHARED WITH PROD is the real risk, and label-scoped teardown plus the orphan reaper are what address it.",
		issue: "#2385",
	},
};

/** @returns {string[]} non-comment `- cron: "..."` values declared in the workflow. */
export function scheduledCrons(workflowText) {
	return workflowText
		.split("\n")
		.filter((l) => !/^\s*#/.test(l))
		.map((l) => l.match(/^\s*-\s*cron:\s*["']([^"']+)["']/))
		.filter((m) => m !== null)
		.map((m) => m[1].trim());
}

/** @returns {string} the cron resolve-dimension.sh maps to the full bar. */
export function fullBarCron(resolverText) {
	const m = resolverText.match(/^FULL_BAR_CRON="([^"]+)"/m);
	if (m === null) {
		throw new Error(`${RESOLVER}: FULL_BAR_CRON is not declared — this guard cannot resolve which cron is the full bar`);
	}
	return m[1].trim();
}

/**
 * The providers a SCHEDULED run fans out to. The matrix expression is a dispatch/schedule ternary:
 * `... workflow_dispatch && fromJSON(one input) || fromJSON('["hetzner",...]')`. The `||` fallback
 * literal is the scheduled set, so we take the LAST JSON array on the line — never the dispatch
 * branch, which is one input-chosen provider.
 * @returns {string[]}
 */
export function scheduledMatrixProviders(workflowText) {
	const line = workflowText.split("\n").find((l) => !/^\s*#/.test(l) && /^\s*provider:\s*\$\{\{/.test(l));
	if (line === undefined) {
		throw new Error(`${WORKFLOW}: no \`provider:\` matrix expression found`);
	}
	const arrays = [...line.matchAll(/fromJSON\('(\[[^']*\])'\)/g)];
	if (arrays.length === 0) {
		throw new Error(`${WORKFLOW}: the \`provider:\` matrix declares no literal fromJSON array — cannot determine the scheduled set`);
	}
	return JSON.parse(arrays[arrays.length - 1][1]);
}

/**
 * The providers the cost-ceiling expression actually prices — every `matrix.provider == 'x'` in the
 * ALETHIA_COST_CEILING_MONTHLY_USD value. A cloud absent from that expression receives `''`, which
 * cost_ceiling.go treats as "guard disabled".
 * @returns {string[]}
 */
export function pricedProviders(workflowText) {
	const line = workflowText.split("\n").find((l) => !/^\s*#/.test(l) && /ALETHIA_COST_CEILING_MONTHLY_USD:/.test(l));
	if (line === undefined) {
		throw new Error(`${WORKFLOW}: ALETHIA_COST_CEILING_MONTHLY_USD is not set anywhere — the cost guard is not wired at all`);
	}
	return [...new Set([...line.matchAll(/matrix\.provider\s*==\s*'([a-z0-9-]+)'/g)].map((m) => m[1]))];
}

/**
 * Evaluate the three rules against already-read inputs. Pure, so `--self-test` drives it with
 * fixtures instead of writing files.
 * @returns {{failures: string[], notes: string[]}}
 */
export function analyse({ workflowText, resolverText, exemptions }) {
	const failures = [];
	const notes = [];

	const crons = scheduledCrons(workflowText);
	const fullCron = fullBarCron(resolverText);
	const matrix = scheduledMatrixProviders(workflowText);
	const priced = pricedProviders(workflowText);
	const exempt = Object.keys(exemptions);

	// R1 — priced and exempt are disjoint.
	for (const p of priced.filter((p) => exempt.includes(p))) {
		failures.push(
			`R1 ${p}: listed as BOTH priced (it appears in ALETHIA_COST_CEILING_MONTHLY_USD) and exempt ` +
				`(UNPRICED_EXEMPTIONS in this script). Pick one — an exemption for a cloud that is already ` +
				`priced reads as an accepted risk that no longer exists.`,
		);
	}

	// R2 — priced ∪ exempt == matrix, both directions.
	for (const p of matrix.filter((p) => !priced.includes(p) && !exempt.includes(p))) {
		failures.push(
			`R2 ${p}: in the scheduled matrix with NO spend story — neither priced by ` +
				`ALETHIA_COST_CEILING_MONTHLY_USD nor carrying an UNPRICED_EXEMPTIONS entry. Add a ceiling ` +
				`branch, or an exemption naming why and an open issue.`,
		);
	}
	for (const p of exempt.filter((p) => !matrix.includes(p))) {
		failures.push(
			`R2 ${p}: has an UNPRICED_EXEMPTIONS entry but is NOT in the scheduled matrix. Stale exemptions ` +
				`are how a real hole hides behind a reviewed-looking list — delete it.`,
		);
	}
	for (const [p, e] of Object.entries(exemptions)) {
		if (!/^#\d+$/.test(e.issue ?? "")) {
			failures.push(`R2 ${p}: exemption must name an issue as \`#<n>\` — got ${JSON.stringify(e.issue)}.`);
		}
		if ((e.why ?? "").trim().length < 40) {
			failures.push(`R2 ${p}: exemption \`why\` is too short to be a reason. Say what would fail and what would close it.`);
		}
	}

	// R3 — a SCHEDULED full bar requires every matrix cloud priced. Exemptions do not satisfy it.
	const fullBarSchedules = crons.filter((c) => c === fullCron);
	if (fullBarSchedules.length > 0) {
		const unpriced = matrix.filter((p) => !priced.includes(p));
		if (unpriced.length > 0) {
			failures.push(
				`R3: cron "${fullCron}" SCHEDULES the full bar, but ${unpriced.length} of ${matrix.length} ` +
					`matrix clouds have no cost ceiling: ${unpriced.join(", ")}. A timer must not start an ` +
					`unpriced real apply — that is exactly what removing this cron fixed. Either price those ` +
					`clouds in ALETHIA_COST_CEILING_MONTHLY_USD, or run the full bar by dispatch.`,
			);
		}
	} else {
		notes.push(
			`R3 is vacuous: no scheduled cron resolves to the full bar (looked for "${fullCron}"). ` +
				`The full bar is dispatch-only, which is the intended steady state.`,
		);
	}

	notes.push(`scheduled crons: ${crons.length === 0 ? "(none)" : crons.map((c) => `"${c}"`).join(", ")}`);
	notes.push(`scheduled matrix: ${matrix.join(", ")}`);
	notes.push(`priced: ${priced.length === 0 ? "(none)" : priced.join(", ")} · exempt: ${exempt.join(", ")}`);

	return { failures, notes };
}

// ───────────────────────────── self-test ─────────────────────────────

const FIXTURE_RESOLVER = 'FULL_BAR_CRON="17 5 * * 0"\n';

/** Build a workflow fixture. `crons` are scheduled; `priced` get a ceiling branch. */
function fixture({ crons, matrix, priced }) {
	const ceiling =
		priced.length === 0
			? "''"
			: `${priced.map((p) => `matrix.provider == '${p}' && '300'`).join(" || ")} || ''`;
	return [
		"on:",
		"  schedule:",
		...crons.map((c) => `    - cron: "${c}"`),
		"    strategy:",
		"      matrix:",
		`        provider: \${{ github.event_name == 'workflow_dispatch' && fromJSON(format('["{0}"]', github.event.inputs.provider)) || fromJSON('${JSON.stringify(matrix)}') }}`,
		`          ALETHIA_COST_CEILING_MONTHLY_USD: \${{ ${ceiling} }}`,
	].join("\n");
}

const FIVE = ["hetzner", "aws", "gcp", "azure", "alibaba"];
const FOUR_EXEMPT = {
	gcp: { why: "x".repeat(50), issue: "#1" },
	azure: { why: "x".repeat(50), issue: "#1" },
	alibaba: { why: "x".repeat(50), issue: "#1" },
	hetzner: { why: "x".repeat(50), issue: "#1" },
};

function runSelfTest() {
	let fails = 0;
	/** @param {string} name @param {boolean} ok @param {string} [detail] */
	const assert = (name, ok, detail = "") => {
		if (ok) {
			console.log(`ok   - ${name}`);
		} else {
			console.error(`FAIL - ${name}${detail ? `: ${detail}` : ""}`);
			fails++;
		}
	};
	const run = (wf, ex = FOUR_EXEMPT) =>
		analyse({ workflowText: wf, resolverText: FIXTURE_RESOLVER, exemptions: ex });

	// THE REGRESSION. The world as it stood before this change: the weekly cron plus an aws-only
	// ceiling. If this ever passes, the guard is worthless.
	const regression = run(
		fixture({ crons: ["17 3 * * *", "17 5 * * 0"], matrix: FIVE, priced: ["aws"] }),
	);
	assert(
		"the removed Sunday cron + an aws-only ceiling FAILS R3",
		regression.failures.some((f) => f.startsWith("R3:")),
		JSON.stringify(regression.failures),
	);
	assert(
		"...and R3 names every unpriced cloud, not just the first",
		["hetzner", "gcp", "azure", "alibaba"].every((p) =>
			regression.failures.some((f) => f.startsWith("R3:") && f.includes(p)),
		),
		JSON.stringify(regression.failures),
	);

	// TODAY. Floor cron only, aws priced, the other four exempt.
	const today = run(fixture({ crons: ["17 3 * * *"], matrix: FIVE, priced: ["aws"] }));
	assert("today's shape (no full-bar cron, aws priced, four exempt) passes", today.failures.length === 0, JSON.stringify(today.failures));
	assert("...and says R3 is vacuous rather than silently passing", today.notes.some((n) => n.includes("vacuous")));

	// A full-bar cron is allowed once every matrix cloud is priced — the guard gates, never forbids.
	const allPriced = run(fixture({ crons: ["17 3 * * *", "17 5 * * 0"], matrix: FIVE, priced: FIVE }), {});
	assert("a full-bar cron with EVERY cloud priced passes", allPriced.failures.length === 0, JSON.stringify(allPriced.failures));

	// An exemption does NOT buy a scheduled full bar. This is the rule's whole point.
	const exemptDoesNotCount = run(fixture({ crons: ["17 5 * * 0"], matrix: FIVE, priced: ["aws"] }));
	assert(
		"exemptions do NOT satisfy a scheduled full bar",
		exemptDoesNotCount.failures.some((f) => f.startsWith("R3:")),
		JSON.stringify(exemptDoesNotCount.failures),
	);

	// R2 both directions.
	const sixth = run(fixture({ crons: ["17 3 * * *"], matrix: [...FIVE, "oracle"], priced: ["aws"] }));
	assert(
		"a new matrix cloud with no spend story FAILS R2",
		sixth.failures.some((f) => f.startsWith("R2 oracle:")),
		JSON.stringify(sixth.failures),
	);
	const stale = run(fixture({ crons: ["17 3 * * *"], matrix: ["aws", "gcp", "azure", "alibaba"], priced: ["aws"] }));
	assert(
		"an exemption for a cloud that left the matrix FAILS R2 as stale",
		stale.failures.some((f) => f.startsWith("R2 hetzner:") && /stale/i.test(f)),
		JSON.stringify(stale.failures),
	);

	// R1.
	const both = run(fixture({ crons: ["17 3 * * *"], matrix: FIVE, priced: ["aws", "gcp"] }));
	assert("a cloud both priced and exempt FAILS R1", both.failures.some((f) => f.startsWith("R1 gcp:")), JSON.stringify(both.failures));

	// Exemption quality.
	const thin = run(fixture({ crons: ["17 3 * * *"], matrix: FIVE, priced: ["aws"] }), {
		...FOUR_EXEMPT,
		gcp: { why: "too short", issue: "#1" },
	});
	assert("a one-line exemption reason FAILS", thin.failures.some((f) => f.includes("too short to be a reason")));
	const noIssue = run(fixture({ crons: ["17 3 * * *"], matrix: FIVE, priced: ["aws"] }), {
		...FOUR_EXEMPT,
		gcp: { why: "x".repeat(50), issue: "later" },
	});
	assert("an exemption with no issue number FAILS", noIssue.failures.some((f) => f.includes("must name an issue")));

	// VACUITY. A guard whose failure mode is silence is worse than a noisy one — seed everything
	// wrong at once and assert it reports a pile, not zero. (The a05-fidelity guard compared 2 of 35
	// keys and read as green; this is the check that would have caught it.)
	const allWrong = run(fixture({ crons: ["17 5 * * 0"], matrix: [...FIVE, "oracle"], priced: ["aws", "gcp"] }), {
		...FOUR_EXEMPT,
		vultr: { why: "x".repeat(50), issue: "#1" },
	});
	assert(
		"vacuity: a wholly broken input reports many failures, not zero",
		allWrong.failures.length >= 4,
		`only ${allWrong.failures.length}: ${JSON.stringify(allWrong.failures)}`,
	);
	assert(
		"vacuity: and it spans all three rules",
		["R1", "R2", "R3"].every((r) => allWrong.failures.some((f) => f.startsWith(r))),
		JSON.stringify(allWrong.failures),
	);

	// A resolver with no FULL_BAR_CRON must throw, never default to "nothing is the full bar" —
	// which would make R3 silently unreachable.
	let threw = false;
	try {
		analyse({ workflowText: fixture({ crons: [], matrix: FIVE, priced: ["aws"] }), resolverText: "# nothing\n", exemptions: FOUR_EXEMPT });
	} catch {
		threw = true;
	}
	assert("a resolver missing FULL_BAR_CRON throws rather than disabling R3", threw);

	if (fails > 0) {
		console.error(`\nself-test: ${fails} check(s) FAILED`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ───────────────────────────── main ─────────────────────────────

// Only when EXECUTED, never on import: the analysis helpers above are exported so a test (or the
// programme rollup) can drive them with fixtures, and a module whose import reads two files and can
// call process.exit is not importable.
const executedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${fs.realpathSync(process.argv[1])}`;

if (!executedDirectly) {
	// imported — expose the helpers and do nothing else.
} else if (process.argv.includes("--self-test")) {
	runSelfTest();
} else {
	const { failures, notes } = analyse({
		workflowText: fs.readFileSync(WORKFLOW, "utf8"),
		resolverText: fs.readFileSync(RESOLVER, "utf8"),
		exemptions: UNPRICED_EXEMPTIONS,
	});
	for (const n of notes) {
		console.log(`note: ${n}`);
	}
	if (failures.length > 0) {
		for (const f of failures) {
			console.error(`::error::e2e spend guard: ${f}`);
		}
		console.error(`\ne2e spend guard: ${failures.length} failure(s).`);
		process.exit(1);
	}
	console.log("\ne2e spend guard: OK");
}
