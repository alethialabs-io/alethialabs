#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// The `guards` job is a BAG of independent checks. Keep it one.
//
// WHY THIS EXISTS. `Authz / open-core guards` is a REQUIRED check and had grown to 77 steps with
// ZERO of them conditional. GitHub Actions stops a job at its first failing step, so a failure at
// index 4 (`Open-core boundary`) silently skipped 73 others — including `Drizzle migration history
// is unforked`, `Proof-scrub denylist` and `Guards self-test`. None of those has anything to do
// with the open-core boundary. A red run therefore reported ONE finding and hid however many more
// were sitting behind it, and every fix-and-rerun cycle rediscovered them one at a time.
//
// Steps 0-3 (checkout · pnpm · node · install) are a genuine dependency chain and stay
// unconditional: running a check before its toolchain exists produces a failure about the wrong
// thing.
//
// WHY A GUARD AND NOT JUST THE EDIT. The edit is 73 lines and decays in one commit — the next
// person to add a guard step appends it without an `if:`, and it silently rejoins the veto chain
// at the bottom, where it also becomes the step most likely to be skipped. Nothing would say so.
//
//   node scripts/ci/check-guards-independent.mjs
//   node scripts/ci/check-guards-independent.mjs --self-test
//
// It parses YAML line-wise on purpose: `yaml` is a dependency of apps/console, not of the root, and
// this runs under plain `node`. That is a real risk — a line parser that stops matching silently
// finds nothing and reports success — so the FLOOR below exists to make "found nothing" impossible
// to confuse with "found nothing wrong".

import fs from "node:fs";

export const PRELUDE = 4;

// A parser that has stopped understanding the file finds zero steps and passes. The `guards` job
// has had dozens of steps for its whole life; if this ever sees fewer than a few, the file's shape
// changed and this check is no longer reading what it believes it is. That is a FAILURE, not a pass.
export const MIN_STEPS = 40;

/** The condition every independent guards step must carry. See `check` for why both halves matter. */
export const WANT = "if: ${{ !cancelled() && steps.setup.outcome == 'success' }}";

/**
 * Extract the `guards` job's steps from a workflow file's text.
 * @param {string} text
 * @returns {{steps: {name: string, line: number, hasIf: boolean}[], error?: string}}
 */
export function parseGuardsSteps(text) {
	const lines = text.split("\n");
	const jobStart = lines.findIndex((l) => l === "  guards:");
	if (jobStart === -1) return { steps: [], error: "no `guards:` job found in the workflow" };
	let jobEnd = lines.length;
	for (let i = jobStart + 1; i < lines.length; i++) {
		if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
			jobEnd = i;
			break;
		}
	}
	const stepsRel = lines.slice(jobStart, jobEnd).findIndex((l) => l === "    steps:");
	if (stepsRel === -1) return { steps: [], error: "the `guards:` job has no `steps:` block" };
	const stepsAt = jobStart + stepsRel;

	const steps = [];
	for (let i = stepsAt + 1; i < jobEnd; i++) {
		if (!/^      - \S/.test(lines[i])) continue;
		// The step's own keys run until the next step head or the end of the job.
		let cond = null;
		let name = lines[i].replace(/^      - /, "").trim();
		for (let j = i + 1; j < jobEnd; j++) {
			if (/^      - \S/.test(lines[j])) break;
			const c = lines[j].match(/^        if:\s*(.+)$/);
			if (c) cond = c[1].trim();
			const n = lines[j].match(/^        name:\s*(.+)$/);
			if (n && /^(run|uses|env|with|id):/.test(name)) name = n[1].trim();
		}
		const nm = lines[i].match(/^      - name:\s*(.+)$/);
		steps.push({ name: nm ? nm[1].trim() : name, line: i + 1, hasIf: cond !== null, cond });
	}
	return { steps };
}

/**
 * @param {string} text
 * @returns {string[]} failures; empty means the job is a bag of independent checks
 */
export function check(text) {
	const { steps, error } = parseGuardsSteps(text);
	if (error) return [`${error} — this check cannot run, which is not the same as passing.`];
	if (steps.length < MIN_STEPS) {
		return [
			`only ${steps.length} step(s) parsed out of the \`guards\` job, which has always had many more. ` +
				`The file's shape has changed and this check is no longer reading what it believes it is — ` +
				`fix the parser rather than lowering MIN_STEPS (${MIN_STEPS}).`,
		];
	}
	const out = [];
	for (const [i, s] of steps.entries()) {
		if (i < PRELUDE) {
			// The prelude must stay unconditional: a check that runs before its toolchain exists fails
			// about the wrong thing, and this guard would then be enforcing the opposite of its point.
			if (s.hasIf) {
				out.push(
					`ci.yml:${s.line}: prelude step ${i} (\`${s.name}\`) carries an \`if:\`. Steps 0-${PRELUDE - 1} are the ` +
						"toolchain (checkout · pnpm · node · install) and are a real dependency chain — they must stay unconditional.",
				);
			}
			continue;
		}
		if (!s.hasIf) {
			out.push(
				`ci.yml:${s.line}: guards step ${i} (\`${s.name}\`) has no \`if:\`, so a failure ANYWHERE above it silently ` +
					`skips it — and it skips every step below it in turn. Add \`${WANT}\`. ` +
					"The `guards` job is a bag of independent checks; one failing check must not hide the rest.",
			);
			continue;
		}
		// TWO properties, and both are load-bearing:
		//
		//   !cancelled()                       — otherwise the step inherits the implicit success()
		//                                        and rejoins the veto chain, which is the defect.
		//   steps.setup.outcome == 'success'   — otherwise a failed `pnpm install` produces 75
		//                                        simultaneous failures about missing node_modules,
		//                                        burying the one real cause. The prelude IS a genuine
		//                                        dependency; independence is only among the checks.
		//
		// Substring, not equality, so a step may add `&& <more>` for its own reasons. This does mean
		// matching a rendering rather than a parse — accepted here because the failure mode is safe:
		// an unrecognised-but-valid condition is REPORTED and fixed, never silently allowed.
		if (!s.cond.includes("!cancelled()")) {
			out.push(
				`ci.yml:${s.line}: guards step ${i} (\`${s.name}\`) has \`if: ${s.cond}\`, which does not contain ` +
					"`!cancelled()`. Without it the step inherits the implicit `success()` and is skipped by any earlier " +
					"failure — the veto chain this check exists to prevent.",
			);
		} else if (!s.cond.includes("steps.setup.outcome")) {
			out.push(
				`ci.yml:${s.line}: guards step ${i} (\`${s.name}\`) has \`if: ${s.cond}\`, which does not gate on ` +
					"`steps.setup.outcome == 'success'`. A failed `pnpm install` would then run every check against a " +
					"missing toolchain and report dozens of failures about the wrong thing, burying the real one.",
			);
		}
	}
	return out;
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────
function selfTest() {
	let fails = 0;
	const ok = (name, cond, detail = "") => {
		if (cond) console.log(`ok   - ${name}`);
		else {
			console.error(`FAIL - ${name} ${detail}`);
			fails++;
		}
	};

	const head = ["jobs:", "  guards:", "    name: Authz / open-core guards", "    steps:"];
	const prelude = [
		"      - uses: actions/checkout@v7",
		"      - uses: pnpm/action-setup@v6",
		"      - uses: actions/setup-node@v7",
		"      - id: setup\n        run: pnpm install --frozen-lockfile",
	];
	/** n armed check steps. */
	const armed = (n, from = 0) =>
		Array.from({ length: n }, (_, i) => [`      - name: check ${from + i}`, "        if: ${{ !cancelled() && steps.setup.outcome == 'success' }}", `        run: pnpm check-${from + i}`]).flat();
	const bare = (n, from = 0) =>
		Array.from({ length: n }, (_, i) => [`      - name: check ${from + i}`, `        run: pnpm check-${from + i}`]).flat();
	const wf = (...blocks) => [...head, ...prelude, ...blocks.flat(), "  other:", "    steps:", "      - run: true"].join("\n");

	ok("a fully armed job passes", check(wf(armed(MIN_STEPS))).length === 0, JSON.stringify(check(wf(armed(MIN_STEPS)))));

	// THE REGRESSION.
	const oneBare = check(wf(armed(20), bare(1, 20), armed(20, 21)));
	ok("one unconditional check step is a failure", oneBare.length === 1, JSON.stringify(oneBare));
	ok("...and it is named and located", /check 20/.test(oneBare[0]) && /ci\.yml:\d+/.test(oneBare[0]), oneBare[0]);
	ok("...and the message says what it costs", /skips every step below it/.test(oneBare[0]), oneBare[0]);

	// The two halves of the condition fail differently, so both are pinned.
	const wrongCond = (c) => [...head, ...prelude, ...armed(MIN_STEPS), `      - name: sloppy`, `        if: ${c}`, "        run: pnpm x", "  other:", "    steps:", "      - run: true"].join("\n");
	const noCancel = check(wrongCond("${{ always() }}"));
	ok("an `if:` without !cancelled() is a failure", noCancel.length === 1 && /does not contain/.test(noCancel[0]), JSON.stringify(noCancel));
	ok("...and it explains the veto chain", /inherits the implicit `success\(\)`/.test(noCancel[0] ?? ""), noCancel[0]);
	const noSetup = check(wrongCond("${{ !cancelled() }}"));
	ok("an `if:` that does not gate on the toolchain is a failure", noSetup.length === 1 && /steps\.setup\.outcome/.test(noSetup[0]), JSON.stringify(noSetup));
	ok("...and it explains what a failed install would do", /burying the real one/.test(noSetup[0] ?? ""), noSetup[0]);
	// A step may add its own extra condition on top — the check is a substring, not an equality.
	ok("an extra `&&` clause is allowed",
		check(wrongCond("${{ !cancelled() && steps.setup.outcome == 'success' && github.event_name == 'push' }}")).length === 0);

	ok("every unconditional step is reported, not just the first",
		check(wf(bare(MIN_STEPS))).length === MIN_STEPS, String(check(wf(bare(MIN_STEPS))).length));

	// The prelude is the exception, in BOTH directions.
	ok("the prelude may be unconditional", check(wf(armed(MIN_STEPS))).length === 0);
	const armedPrelude = [...head, "      - uses: actions/checkout@v7", "        if: ${{ !cancelled() && steps.setup.outcome == 'success' }}",
		...prelude.slice(1), ...armed(MIN_STEPS), "  other:", "    steps:", "      - run: true"].join("\n");
	ok("...and an `if:` ON the prelude is itself a failure", /prelude step 0/.test(check(armedPrelude)[0] ?? ""), JSON.stringify(check(armedPrelude)));

	// THE PARSER'S OWN BLINDNESS. Each of these would otherwise report a clean bill of health.
	ok("a missing guards job fails rather than passes", /cannot run, which is not the same as passing/.test(check("jobs:\n  other:\n    steps:\n      - run: true")[0] ?? ""));
	ok("a guards job with no steps block fails", /no `steps:` block/.test(check("jobs:\n  guards:\n    name: x\n  other:\n    steps: []")[0] ?? ""));
	ok("too few parsed steps fails loudly", /no longer reading what it believes it is/.test(check(wf(armed(3)))[0] ?? ""), JSON.stringify(check(wf(armed(3)))));
	ok("...and says not to lower the floor", /rather than lowering MIN_STEPS/.test(check(wf(armed(3)))[0] ?? ""));

	// The job boundary must hold: another job's unconditional steps are not this job's problem.
	const twoJobs = [...head, ...prelude, ...armed(MIN_STEPS), "  typescript:", "    steps:",
		"      - name: unconditional elsewhere", "        run: pnpm test"].join("\n");
	ok("steps in a LATER job are not counted", check(twoJobs).length === 0, JSON.stringify(check(twoJobs)));

	if (fails > 0) {
		console.error(`\ncheck-guards-independent self-test: ${fails} failure(s)`);
		process.exit(1);
	}
	console.log("\nself-test: all passed");
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
	selfTest();
} else {
	const file = ".github/workflows/ci.yml";
	const problems = check(fs.readFileSync(file, "utf8"));
	for (const p of problems) console.error(`::error::guards-independent: ${p}`);
	if (problems.length > 0) {
		console.error(`\n${problems.length} problem(s) — the guards job is wired as a pipeline, not a bag.`);
		process.exit(1);
	}
	const { steps } = parseGuardsSteps(fs.readFileSync(file, "utf8"));
	console.log(`guards-independent: ${steps.length} steps · ${steps.length - PRELUDE} independent checks, each with its own \`if:\``);
}
