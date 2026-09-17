#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// MUTATION-TEST check-gate-baseline-slice-ownership.mjs, IN BOTH DIRECTIONS: revert each fix one at
// a time and require the self-test to go RED and name the case that fix exists for.
//
// WHY BOTH DIRECTIONS, STATED AS TWO SEPARATE THINGS.
//
//   · THE DEFECT half (M1–M8) — the guard must red on a slice the PR did not earn. A guard that
//     cannot fire is the ordinary failure and it is at least discoverable, because the thing it
//     was built for keeps happening.
//   · THE STALE-EXEMPTION half (M9–M15) — `TITLE_SOURCES` must red on an entry that has OUTLIVED
//     its subject. This is the half that is nobody's alarm: a stale entry goes on excusing a slice
//     after the generation that justified it is gone, suppresses a real finding, and does it in
//     silence forever. An exemption ledger that only fails in the undeclared direction is exactly
//     half a ledger, and the missing half is the dangerous one.
//
// WHY THIS IS A COMMITTED FILE AND NOT A SCRATCH SCRIPT. A guard shipped alongside its own fix
// passes trivially, so the evidence is not that the self-test passes — it is that the self-test
// FAILS when the implementation is broken, and that evidence has to stay re-runnable by the next
// person or it is a claim in a PR description that decays the moment the file is edited.
//
// AND WHY EVERY MUTATION ASSERTS THAT IT APPLIED. A mutation whose anchor no longer matches leaves
// the file untouched and produces a PASSING run — indistinguishable from "this case is not load
// bearing", and identical in shape to the defect this guard is itself about.
//
// AND WHY THE EXIT CODE IS THE TEST. A counter incremented in a subshell never reaches the parent,
// so a suite can print `FAIL` and summarise "all passed". `selfTest` below reads the RUN's exit
// code, and then requires the self-test's own summary line — printed only on the orderly failure
// path — to agree with the number of FAIL lines seen. Without that, a mutation that fails its case
// and then THROWS prints a plausible couple of FAIL lines while a hundred assertions went
// unevaluated, and exit 0 afterwards is the harness telling you it verified something it did not.
//
//   node scripts/ci/check-gate-baseline-slice-ownership.mutations.mjs
//
// NOT wired into CI: it rewrites the guard's source in place (restoring after each case), which is
// safe to run alone and unsafe to run beside anything else reading that file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(HERE, "check-gate-baseline-slice-ownership.mjs");

/**
 * Each entry reverts ONE fix to a shape it plausibly had before, and names the self-test case that
 * must then fail. `expect` is matched against the failing assertion names.
 */
const MUTATIONS = [
	// ── the DEFECT direction ──────────────────────────────────────────────────────────────────
	{
		name: "M1  every slice treated as owned by the PR (the guard can never fire)",
		from: "\t\tif (touchesSpec(file)) continue; // R1",
		to: "\t\tif (true) continue; // R1",
		expect: /D1|D2|D3/,
	},
	{
		name: "M2  R1 matched on the slice key's STEM (`rbac.negative.spec.ts` earns `rbac.spec.ts`'s slice)",
		from: "const touchesSpec = (file) => changedFiles.some((c) => c === file || c.endsWith(`/${file}`));",
		to: 'const touchesSpec = (file) => changedFiles.some((c) => c.includes(file.replace(/\\.spec\\.ts$/, "")));',
		expect: /NEAR-MISS/,
	},
	{
		name: "M2b R1's LEADING path boundary dropped (`xflows/rbac.spec.ts` earns `flows/rbac.spec.ts`'s slice)",
		from: "const touchesSpec = (file) => changedFiles.some((c) => c === file || c.endsWith(`/${file}`));",
		to: "const touchesSpec = (file) => changedFiles.some((c) => c === file || c.endsWith(file));",
		expect: /ENDS WITH the slice key/,
	},
	{
		name: "M3  R3 back to `every change ends at passed` — an ADDED entry reads as a tightening (#4433's shape)",
		from: 'if (changes.every((c) => c.from !== undefined && isPassed(c.to))) {',
		to: "if (changes.every((c) => isPassed(c.to))) {",
		expect: /D3/,
	},
	{
		name: "M4  R2 applied to every slice — a bootstrap pass for slices that already existed",
		from: "\t\tif (!existedBefore) {",
		to: "\t\tif (true) {",
		expect: /D1|D2|R2/,
	},
	{
		name: "M5  R4 widened to `the baseline is among the changed files`",
		from: "\tconst ledgerOnly = changedFiles.length === 1 && changedFiles[0] === BASELINE;",
		to: "\tconst ledgerOnly = changedFiles.includes(BASELINE);",
		expect: /R4|D1|D2|D3/,
	},
	{
		name: "M6  R5 satisfied by the ENTRY EXISTING rather than by the PR moving a source",
		from: "\t\tif (entry !== undefined && entry.sources.some((s) => changed.has(s))) {",
		to: "\t\tif (entry !== undefined) {",
		expect: /R5|registry edit/,
	},
	{
		name: "M7  an empty changed-file list read as a clean PR instead of refused",
		from: "\tif (changedFiles.length === 0) {",
		to: "\tif (false) {",
		expect: /EMPTY changed-file list/,
	},
	{
		name: "M8  slice values compared by raw JSON text, so a REORDERED record reads as a rewrite",
		from: "\t\tif (typeof v !== \"object\" || v === null) return JSON.stringify(v);",
		to: "\t\treturn JSON.stringify(v);",
		expect: /REORDERED/,
	},
	{
		name: "M8b `existedBefore` hard-coded true in diffSlices (a birth reads as a rewrite)",
		from: "if (changes.length > 0) out.push({ project, file, changes, existedBefore: Object.keys(ta).length > 0 });",
		to: "if (changes.length > 0) out.push({ project, file, changes, existedBefore: true });",
		expect: /BIRTH|did not exist before|NEW slice/,
	},

	// ── the STALE-EXEMPTION direction ─────────────────────────────────────────────────────────
	{
		name: "M9  an entry whose SLICE is gone no longer reported (the exemption outlives its subject)",
		from: "\t\tif (projects[project]?.[file] === undefined) {",
		to: "\t\tif (false) {",
		expect: /L1|SLICE is gone/,
	},
	{
		name: "M10 an entry whose declared SOURCE no longer exists is accepted",
		from: "\t\t\tif (!exists(s)) {",
		to: "\t\t\tif (false) {",
		expect: /L2|SOURCE file is gone/,
	},
	{
		name: "M11 an entry whose SPEC FILE is gone is accepted",
		from: "\t\tif (!exists(spec)) {",
		to: "\t\tif (false) {",
		expect: /L3|SPEC file is gone/,
	},
	{
		name: "M12 the interpolation test dropped — an entry stays after the generation it excuses is gone",
		from: "\t\tif (!/^\\s*test(\\.[a-z]+)?\\(\\s*`[^`]*\\$\\{/m.test(read(spec))) {",
		to: "\t\tif (false) {",
		expect: /L4|no longer BUILDS/,
	},
	{
		name: "M13 the reason floor removed — `reason: \"generated\"` becomes a decision",
		from: "\t\tif (typeof entry.reason !== \"string\" || entry.reason.trim().length < REASON_FLOOR) {",
		to: "\t\tif (false) {",
		expect: /L5|under the floor/,
	},
	{
		name: "M14 an entry naming NO sources accepted — it then excuses its slice unconditionally",
		from: "\t\tif (!Array.isArray(entry.sources) || entry.sources.length === 0) {",
		to: "\t\tif (false) {",
		expect: /L6|no sources|naming no sources/,
	},
	{
		name: "M15 a malformed key accepted — the entry then silently never matches anything",
		from: '\t\tif (project === undefined || file === undefined || file === "") {',
		to: "\t\tif (false) {",
		expect: /L7|malformed key/,
	},
	{
		name: "M17 a USAGE error annotated again — two red annotations under a step that passed",
		from: "\t\tconsole.error(`check-gate-baseline-slice-ownership: unrecognised argument(s): ${unknown.join(\" \")}`);",
		to: "\t\tconsole.error(`::error::check-gate-baseline-slice-ownership: unrecognised argument(s): ${unknown.join(\" \")}`);",
		expect: /annotation|render red/,
	},
	{
		name: "M16 the ledger no longer checked against the REAL tree (fixtures only)",
		from: "\tok(\"the SHIPPED TITLE_SOURCES is current against the real tree\", real.length === 0, JSON.stringify(real));",
		to: "\tok(\"the SHIPPED TITLE_SOURCES is current against the real tree\", true);",
		expect: /SHIPPED TITLE_SOURCES|NOTHING/,
		// This one is expected NOT to be load-bearing on a clean tree — it is here to be RUN, not to
		// pass. See `EXPECT_INERT` below: a mutation to an assertion's own subject can only go red if
		// the tree is already broken, and pretending otherwise is how a harness scores a false green.
		inert: true,
	},
];

/** Mutations that are expected NOT to turn the self-test red, with the reason stated. Listing one
 *  here is a claim that has to be true: a mutation that DOES go red while listed inert is reported
 *  as loudly as one that stays green while not. */
const EXPECT_INERT = new Set(["M16 the ledger no longer checked against the REAL tree (fixtures only)"]);

const ORIGINAL = fs.readFileSync(GUARD, "utf8");
let bad = 0;

/**
 * Run the self-test and read its result — including whether it RAN TO THE END.
 * @returns {{rc: number, fails: string[], orderly: boolean, why: string}}
 */
function selfTest() {
	let text;
	let rc = 0;
	try {
		text = execFileSync(process.execPath, [GUARD, "--self-test"], { encoding: "utf8" });
	} catch (e) {
		rc = e.status ?? 1;
		text = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
	}
	const fails = text
		.split("\n")
		.filter((l) => l.startsWith("FAIL"))
		.map((l) => l.replace(/ [[{].*$/, "").replace(/^FAIL - /, ""));
	if (rc === 0) return { rc, fails, orderly: true, why: "" };
	const summary = /check-gate-baseline-slice-ownership self-test: (\d+) failure\(s\)/.exec(text);
	if (summary === null) {
		return {
			rc,
			fails,
			orderly: false,
			why: `the self-test DIED instead of failing — it never printed its summary line, so ${fails.length} FAIL line(s) is a floor, not a count`,
		};
	}
	if (Number(summary[1]) !== fails.length) {
		return { rc, fails, orderly: false, why: `the self-test reported ${summary[1]} failure(s) but ${fails.length} were printed` };
	}
	return { rc, fails, orderly: true, why: "" };
}

const control = selfTest();
if (control.rc !== 0) {
	console.error("the UNMUTATED self-test is already failing — fix that before reading anything below.");
	process.exit(1);
}
console.log("control: self-test GREEN\n");

for (const m of MUTATIONS) {
	const hits = ORIGINAL.split(m.from).length - 1;
	if (hits !== 1) {
		console.error(`!! ${m.name}\n   ANCHOR MATCHED ${hits} TIME(S), not 1 — the mutation was NOT applied, and a run that passes now means nothing. Fix the anchor.`);
		bad += 1;
		continue;
	}
	fs.writeFileSync(GUARD, ORIGINAL.replace(m.from, m.to));
	const { rc, fails, orderly, why } = selfTest();
	fs.writeFileSync(GUARD, ORIGINAL);
	const inert = EXPECT_INERT.has(m.name);
	if (rc === 0) {
		if (inert) {
			console.log(`== ${m.name}\n   GREEN, as declared inert — it removes an assertion that can only fire on an already-broken tree.`);
			continue;
		}
		console.error(`!! ${m.name}\n   SELF-TEST STILL PASSED — this fix is not load-bearing, or nothing tests it.`);
		bad += 1;
		continue;
	}
	if (inert) {
		console.error(`!! ${m.name}\n   RED, but it is declared INERT. The declaration is wrong — either the tree is already broken or this mutation is load-bearing after all. Fix the list, not the run.`);
		bad += 1;
		continue;
	}
	if (!orderly) {
		console.error(`!! ${m.name}\n   RED FOR THE WRONG REASON: ${why}. A mutation must make assertions FAIL, not make the run crash — otherwise the assertions after the crash were never evaluated and this proves nothing about them.`);
		bad += 1;
		continue;
	}
	const named = fails.some((f) => m.expect.test(f));
	console.log(`== ${m.name}\n   RED, ${fails.length} assertion(s)${named ? "" : "  ⚠ but NOT the one this fix exists for"}`);
	for (const f of fails.slice(0, 3)) console.log(`      ${f}`);
	if (fails.length > 3) console.log(`      … and ${fails.length - 3} more`);
	if (!named) bad += 1;
}

const after = selfTest();
console.log(`\nrestored: self-test ${after.rc === 0 ? "GREEN" : "RED — THE RESTORE FAILED"}`);
if (after.rc !== 0) bad += 1;
if (bad > 0) {
	console.error(`\n${bad} mutation(s) did not behave as a load-bearing fix should.`);
	process.exit(1);
}
const live = MUTATIONS.length - EXPECT_INERT.size;
console.log(`\nall ${live} load-bearing mutation(s) turned the self-test red and named their own case; ${EXPECT_INERT.size} declared inert behaved as declared.`);
