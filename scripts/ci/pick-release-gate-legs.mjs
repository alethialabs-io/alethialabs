#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// WHICH RELEASE-GATE LEGS THIS DIFF CAN AFFECT.
//
//   node scripts/ci/pick-release-gate-legs.mjs --legs=<file.json> --changed=<file.txt> \
//        [--base-ref=<branch>] [--want=<a,b>] [--all]
//   node scripts/ci/pick-release-gate-legs.mjs --self-test
//
// All seven legs cost ~76 runner-minutes — qa 34m, canvas 21m, audit 10m, console 5m, hero 3m,
// elench-ai 3m, plus audit-interaction. A lane iterating on ONE spec file paid all of it on every
// push, and CI capacity, not authoring, is the release-gate wave's ceiling (#4440).
//
// ── THE LEG TABLE IS NOT HERE, AND THAT IS DELIBERATE ───────────────────────────────────────────
//
// `.github/workflows/release-gate.yml` owns it, and it must: `playwright.config.ts`'s dead-zone
// guard (#2875) scans `.github/workflows/**` for the LITERAL string `--project=<name>` to prove
// every project runs somewhere. Move the table here and that guard goes quietly blind — a project
// could then run nowhere while the config claimed it ran. So the workflow passes the table in and
// this file only ever FILTERS it.
//
// ── THE NARROWING IS TIMID, AND ONLY IN ONE DIRECTION ───────────────────────────────────────────
//
// It may only ever remove legs from a `dev` PR. Four rules, in order:
//
//   1. A promotion (base `main`/`staging`), an explicit dispatch selection, or `release-gate:all`
//      runs EVERYTHING. A promotion must not choose what measures it.
//   2. A shared e2e seam changed → everything. The config, the helpers and fixtures, the ratchet,
//      the route manifest, the workflow itself: any of them can move any leg, so inferring from
//      paths there would be exactly the under-reporting the gate exists to refuse.
//   3. Otherwise, spec files map to the ONE leg that runs them. This is the case that pays — the
//      repeated push, where a lane is fixing selectors or regenerating its baseline slice.
//   4. ANYTHING ELSE → everything. Product code, packages, docs, or an empty file list from a
//      failed API call. **"Nothing matched" and "nothing needs running" are the same input and must
//      not be the same output** — that equivalence is how a gate goes vacuously green.
//
// Rule 4 is why this is worth having at all rather than being a clever path matcher: the default is
// the expensive, safe answer, and narrowing happens only on positive evidence.

import { readFileSync } from "node:fs";

/** Files that can move ANY leg. A change here refuses the narrowing outright. */
export const SEAMS = [
	/^apps\/console\/playwright\.config\.ts$/,
	/^apps\/console\/e2e\/(helpers|fixtures|reporters)\//,
	/^apps\/console\/e2e\/gate-baseline\.json$/,
	/^scripts\/e2e-ratchet\.mjs$/,
	/^scripts\/lib\/console-routes\.mjs$/,
	/^\.github\/workflows\/release-gate\.yml$/,
];

/**
 * Spec path → the one leg that runs it.
 *
 * ORDER MATTERS and the first two are why: `destructive.spec.ts` lives inside `e2e/audit/`, so a
 * bare `audit/` rule would claim it and the `audit-interaction` leg would never be selected for its
 * own spec. Longest-prefix first, and the self-test pins exactly that.
 */
export const SPEC_RULES = [
	[/^apps\/console\/e2e\/audit\/destructive\.spec\.ts$/, "audit-interaction"],
	[/^apps\/console\/e2e\/audit\/.*\.spec\.ts$/, "audit"],
	[/^apps\/console\/e2e\/flows\/.*\.spec\.ts$/, "qa"],
	[/^apps\/console\/e2e\/architecture-canvas\.spec\.ts$/, "canvas"],
	[/^apps\/console\/e2e\/elench-[^/]*\.spec\.ts$/, "elench-ai"],
	[/^apps\/console\/e2e\/[^/]+\.spec\.ts$/, "console"],
];

/**
 * @typedef {{project: string}} Leg
 * @param {{legs: Leg[], changed: string[], baseRef?: string, want?: string[], all?: boolean}} input
 * @returns {{chosen: Leg[], why: string, narrowed: boolean}}
 */
export function pick({ legs, changed, baseRef = "", want = [], all = false }) {
	const everything = (why) => ({ chosen: legs, why, narrowed: false });

	if (want.length) {
		const unknown = want.filter((w) => !legs.some((l) => l.project === w));
		if (unknown.length) throw new Error(`unknown leg(s): ${unknown.join(", ")} (known: ${legs.map((l) => l.project).join(", ")})`);
		return { chosen: legs.filter((l) => want.includes(l.project)), why: `dispatch input "${want.join(",")}"`, narrowed: true };
	}
	if (baseRef === "main" || baseRef === "staging") {
		return everything(`a promotion into ${baseRef} — a promotion never chooses what measures it`);
	}
	if (all) return everything("the release-gate:all label");
	if (changed.length === 0) return everything("the changed-file list was empty or could not be read — narrowing needs evidence");

	const seam = changed.find((f) => SEAMS.some((re) => re.test(f)));
	if (seam) return everything(`${seam} is a shared e2e seam, and any seam can move any leg`);

	/** @type {Set<string>} */
	const picked = new Set();
	for (const f of changed) {
		const rule = SPEC_RULES.find(([re]) => re.test(f));
		if (!rule) return everything(`${f} matches no spec rule, so this diff is not spec-only`);
		picked.add(rule[1]);
	}
	const chosen = legs.filter((l) => picked.has(l.project));
	// A spec whose rule names a leg the table does not carry would otherwise silently select
	// nothing, which rule 4 exists to forbid.
	if (chosen.length === 0) return everything("the matched legs are not in the leg table");
	return { chosen, why: "a spec-only diff", narrowed: true };
}

// ── self-test ───────────────────────────────────────────────────────────────────────────────────

function selfTest() {
	const legs = ["hero", "elench-ai", "console", "canvas", "qa", "audit", "audit-interaction"].map((project) => ({ project }));
	const names = (r) => r.chosen.map((l) => l.project).join(",");
	/** @type {{name: string, ok: boolean, detail?: string}[]} */
	const out = [];
	const check = (name, ok, detail) => out.push({ name, ok, detail });

	// Rule 3 — the case that pays.
	check("a flows-only diff runs qa alone", names(pick({ legs, changed: ["apps/console/e2e/flows/alerts.spec.ts"] })) === "qa");
	check(
		"two flows files still run qa alone",
		names(pick({ legs, changed: ["apps/console/e2e/flows/a.spec.ts", "apps/console/e2e/flows/b.spec.ts"] })) === "qa",
	);
	check(
		"a spec-only diff across two domains runs both their legs and nothing else",
		names(pick({ legs, changed: ["apps/console/e2e/flows/a.spec.ts", "apps/console/e2e/architecture-canvas.spec.ts"] })) === "canvas,qa",
	);
	// The ordering trap.
	check(
		"destructive.spec.ts selects audit-interaction, NOT audit",
		names(pick({ legs, changed: ["apps/console/e2e/audit/destructive.spec.ts"] })) === "audit-interaction",
	);
	check(
		"…and another audit spec still selects audit",
		names(pick({ legs, changed: ["apps/console/e2e/audit/routes.spec.ts"] })) === "audit",
	);

	// Rule 4 — the direction that must never narrow.
	const all = legs.map((l) => l.project).join(",");
	check("product code runs EVERY leg", names(pick({ legs, changed: ["apps/console/components/alerts/channels-panel.tsx"] })) === all);
	check("a spec PLUS product code runs every leg", names(pick({ legs, changed: ["apps/console/e2e/flows/a.spec.ts", "apps/console/components/x.tsx"] })) === all);
	check("an EMPTY file list runs every leg — a failed lookup is not an empty diff", names(pick({ legs, changed: [] })) === all);
	check("an unrecognised path runs every leg", names(pick({ legs, changed: ["README.md"] })) === all);
	check("a packages/ change runs every leg", names(pick({ legs, changed: ["packages/ui/src/button.tsx"] })) === all);

	// Rule 2 — seams.
	for (const seam of [
		"apps/console/playwright.config.ts",
		"apps/console/e2e/helpers/seed.ts",
		"apps/console/e2e/fixtures/qa.ts",
		"apps/console/e2e/gate-baseline.json",
		"scripts/e2e-ratchet.mjs",
		"scripts/lib/console-routes.mjs",
		".github/workflows/release-gate.yml",
	]) {
		check(`the seam ${seam} refuses the narrowing`, names(pick({ legs, changed: [seam, "apps/console/e2e/flows/a.spec.ts"] })) === all);
	}

	// Rule 1 — a promotion is never narrowed, even by a spec-only diff.
	check(
		"a promotion into main runs every leg even on a spec-only diff",
		names(pick({ legs, changed: ["apps/console/e2e/flows/a.spec.ts"], baseRef: "main" })) === all,
	);
	check(
		"…and so does one into staging",
		names(pick({ legs, changed: ["apps/console/e2e/flows/a.spec.ts"], baseRef: "staging" })) === all,
	);
	check("release-gate:all runs every leg", names(pick({ legs, changed: ["apps/console/e2e/flows/a.spec.ts"], all: true })) === all);

	// The dispatch path keeps its validation.
	check("an explicit dispatch selection is honoured", names(pick({ legs, changed: [], want: ["qa", "hero"] })) === "hero,qa");
	check(
		"an unknown dispatch leg RAISES rather than selecting nothing",
		(() => {
			try {
				pick({ legs, changed: [], want: ["nope"] });
				return false;
			} catch {
				return true;
			}
		})(),
	);
	// Never empty.
	check("no input can select zero legs", [
		pick({ legs, changed: [] }),
		pick({ legs, changed: ["README.md"] }),
		pick({ legs, changed: ["apps/console/e2e/flows/a.spec.ts"] }),
	].every((r) => r.chosen.length > 0));

	const failed = out.filter((r) => !r.ok);
	for (const r of out) console.log(r.ok ? `ok   - ${r.name}` : `FAIL - ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
	console.log(`\n  ${out.length - failed.length} passed, ${failed.length} failed`);
	return failed.length === 0;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

function arg(name) {
	const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : "";
}

function main() {
	if (process.argv.includes("--self-test")) return selfTest() ? 0 : 1;

	const legsFile = arg("legs");
	if (!legsFile) {
		console.error("::error::--legs=<file.json> is required — the leg table lives in release-gate.yml and is passed in.");
		return 2;
	}
	/** @type {{project: string}[]} */
	const legs = JSON.parse(readFileSync(legsFile, "utf8"));
	if (!Array.isArray(legs) || legs.length === 0) {
		console.error("::error::the leg table is empty — refusing to choose legs from nothing.");
		return 2;
	}
	const changedFile = arg("changed");
	let changed = [];
	if (changedFile) {
		try {
			changed = readFileSync(changedFile, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
		} catch {
			changed = []; // rule 4: unreadable is not empty-of-consequence
		}
	}
	const want = arg("want").split(",").map((s) => s.trim()).filter(Boolean);

	let result;
	try {
		result = pick({ legs, changed, baseRef: arg("base-ref"), want, all: process.argv.includes("--all") });
	} catch (err) {
		console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}

	const skipped = legs.filter((l) => !result.chosen.includes(l)).map((l) => l.project);
	console.log(JSON.stringify(result.chosen));
	console.error(`legs: ${result.chosen.map((l) => l.project).join(", ")}`);
	console.error(`why:  ${result.why}`);
	console.error(skipped.length ? `not run: ${skipped.join(", ")}` : "not run: none — every leg ran.");
	return 0;
}

if (process.argv[1] && process.argv[1].endsWith("pick-release-gate-legs.mjs")) {
	process.exit(main());
}
