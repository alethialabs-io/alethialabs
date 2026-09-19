// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// F8–F10 — THE LIVE PASS OVER THE FILTER STANDARD (#4278). One test per manifest route.
//
// `filters.ts` holds the measurement and states what it can and cannot see; read its header before
// reading a score off this suite. This file owns the subject set, the seeding, the route loop and
// the recording.
//
// ── THE SUBJECT SET IS DERIVED, AND IT IS THE STATIC HALF'S ─────────────────────────────────────
//
// Which routes are list pages, which surfaces each owns and which URL params each surface writes all
// come from `apps/console/scripts/audit-report.mjs --filter-surfaces` — the same `ownedSurfaces()`
// join F1–F6 are scored through, and `check-filter-standard.mjs`'s reading of each surface's
// `useFilterUrlSync` call. Nothing here is typed per page. A route that owns no surface is N/A
// `not-a-list-page` without being visited, which is structural exactly as RUBRIC.md requires.
//
// ── IT WRITES INTO `ui-audit-interaction.json`, NEXT TO R8, AND POOLS NOTHING ───────────────────
//
// This spec keeps its OWN `createReport()` and writes under the run's org slug. `report.ts`'s
// `write()` merges records that share a run key, keyed on (route, predicate), and `inert.spec.ts`
// writes R8 under the same org's slug into the same file — two disjoint predicate sets about one
// organisation, joined by `audit-report.mjs` as the `interaction` section.
//
// ── EVERY ROW IT SEEDS IT DELETES ───────────────────────────────────────────────────────────────
//
// `inert.spec.ts` runs after this file in the same project and org, and counts the controls each
// list renders; `afterAll` removes exactly what `seedFilterFixtures()` wrote.

import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

import { closeDb } from "../helpers/db";
import { cleanFilterFixtures, seedFilterFixtures, type FilterFixtures } from "../helpers/seed-filters";
import { materialize, resolveOrgSlug, resolveOwner, type AuditContext } from "./context";
import { filtersControl, measureRoute, subjectSet, type FilterRoute, type Outcome } from "./filters";
import { consoleRoutes } from "./manifest";
import { createReport } from "./report";

/** The known-PASS surface the first real run is read against (RUBRIC.md, family F). */
const KNOWN_PASS_ROUTE = "/[org]/~/jobs";

/** See the ⚠ below. Raise from the first real run; a fall is a finding. */
const MIN_MEASURED = 1;

const ARTIFACT = "ui-audit-interaction.json";

const manifest = consoleRoutes();
const subject = subjectSet();
const report = createReport();
const ctx: AuditContext = { orgSlug: "", owner: { userId: "", orgId: "" } };
let fixtures: FilterFixtures | null = null;

/** The subject record for a manifest route. RAISES on a route the two seams disagree about. */
function subjectFor(route: string): FilterRoute {
	const found = subject.routes.find((r) => r.route === route);
	if (found === undefined) {
		throw new Error(`${route} is in the route manifest and not in the filter-surface subject set — the two seams have drifted apart, and a route neither can see would be scored by neither.`);
	}
	return found;
}

/** Record one predicate's outcome for one route through the report's own rules. */
function recordOutcome(route: string, url: string, predicate: "F8" | "F9" | "F10", outcome: Outcome): void {
	if (outcome.kind === "verdict") report.record({ route, url, predicate, verdict: outcome.verdict, evidence: outcome.evidence });
	else if (outcome.kind === "na") report.record({ route, url, predicate, verdict: "N/A", reason: outcome.reason });
	else report.notMeasured({ route, url, predicate, reason: outcome.reason, evidence: outcome.evidence });
}

/** Score one route: N/A without a visit when it owns no surface, otherwise measured. */
async function auditRoute(route: string, page: Page): Promise<void> {
	const owned = subjectFor(route);
	if (owned.surfaces.length === 0) {
		for (const id of ["F8", "F9", "F10"] as const) report.record({ route, url: route, predicate: id, verdict: "N/A", reason: "not-a-list-page" });
		return;
	}
	const record = manifest.routes.find((r) => r.route === route);
	let url: string;
	try {
		if (record === undefined) throw new Error("the route is not in the manifest");
		url = materialize(record, { ...ctx, projectSlug: fixtures?.project.slug });
	} catch (err) {
		const reason = `the route could not be materialised: ${err instanceof Error ? err.message : String(err)}`;
		for (const id of ["F8", "F9", "F10"] as const) report.notMeasured({ route, url: route, predicate: id, reason });
		return;
	}
	const result = await measureRoute(page, url, owned.surfaces, () => page.context().newPage());
	recordOutcome(route, url, "F8", result.F8);
	recordOutcome(route, url, "F9", result.F9);
	recordOutcome(route, url, "F10", result.F10);
}

// ── the suite ───────────────────────────────────────────────────────────────────────────────────

test.beforeAll(async ({ browser }, testInfo) => {
	// The control drives four fixture bars end to end — measured at ~50 s on a laptop — before the
	// org is resolved and the rows seeded. The project's 120 s would be spent before a route ran.
	testInfo.setTimeout(300_000);
	const page = await browser.newPage();
	ctx.orgSlug = await resolveOrgSlug(page);
	ctx.owner = await resolveOwner(ctx.orgSlug);

	// THE POSITIVE CONTROL RUNS BEFORE A SINGLE ROUTE IS SCORED, and the run consults it: a red
	// control rewrites every later F8–F10 verdict to NOT MEASURED (#3804).
	const broken = await filtersControl(page);
	if (broken.length > 0) {
		report.withhold(["F8", "F9", "F10"], `F8–F10's positive control is red, so nothing it measures can be believed: ${broken.join(" · ")}`);
	}
	await page.close();

	fixtures = await seedFilterFixtures(ctx.owner);
});

for (const route of manifest.routes) {
	test(`F8–F10 ${route.route}`, async ({ page }) => {
		// One list route is a facet search over up to twelve openers, a fresh tab and a debounce
		// window; a page that is not a list is recorded without a visit and costs nothing.
		test.setTimeout(240_000);
		await auditRoute(route.route, page);
	});
}

test.afterAll(async () => {
	if (fixtures !== null) await cleanFilterFixtures(fixtures);
	fixtures = null;
	// A runKey of "" is a run whose `beforeAll` never resolved an org — see `inert.spec.ts`.
	if (ctx.orgSlug) report.write(ctx.orgSlug, ARTIFACT);
	await closeDb();
});

// ── the guard on this suite's own emptiness ─────────────────────────────────────────────────────
//
// ⚠ `MIN_MEASURED` is 1 on this first landing, for the reason `inert.spec.ts` gives about its own:
// the honest floor is the one the FIRST REAL RUN produces. The line this test prints is what the
// next reader raises it to; a later fall is the finding.

test("F8–F10 measured something — a column of NOT MEASURED is not a pass, and the known PASS passed", () => {
	// Read the MERGED file, not this worker's buffer: a worker restarted after a timeout holds only
	// the records made since. `write()` merges on the run key.
	const file = ctx.orgSlug ? report.write(ctx.orgSlug, ARTIFACT) : null;
	expect(file, "no org slug was resolved, so this run measured nothing and cannot be scored").not.toBeNull();
	if (file === null) return;
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	const records = isRecordFile(parsed) ? parsed.records.filter((r) => ["F8", "F9", "F10"].includes(r.predicate)) : [];

	const lines: string[] = [];
	const problems: string[] = [];
	for (const id of ["F8", "F9", "F10"]) {
		const mine = records.filter((r) => r.predicate === id);
		const measured = mine.filter((r) => r.verdict === "PASS" || r.verdict === "FAIL");
		const notMeasured = mine.filter((r) => r.verdict === "NOT MEASURED");
		const na = mine.filter((r) => r.verdict === "N/A");
		lines.push(
			`${id}: ${measured.length} measured (${measured.filter((r) => r.verdict === "FAIL").length} FAIL), ${notMeasured.length} not measured, ${na.length} N/A ` +
				`= ${mine.length} of ${manifest.routes.length} routes`,
		);
		for (const r of notMeasured) lines.push(`  · ${r.route}: NOT MEASURED — ${r.reason}`);
		if (mine.length !== manifest.routes.length) problems.push(`${id} has ${mine.length} record(s) for ${manifest.routes.length} routes — a route recorded nowhere shrinks the denominator to fit the answer.`);
		if (measured.length < MIN_MEASURED) problems.push(`${id}: ${measured.length} route(s) produced a PASS or a FAIL, under the floor of ${MIN_MEASURED}.`);
	}
	const withheld = report.withheld().get("F8");
	if (withheld !== undefined) problems.push(`the positive control was red, so every verdict was withheld: ${withheld}`);

	// The known PASS. The jobs page is the standard's own pilot (`lib/query/README.md`), so an F8–F10
	// that does not pass on it is first a question about THIS instrument, and is read as one.
	const known = records.filter((r) => r.route === KNOWN_PASS_ROUTE);
	for (const r of known) {
		if (r.verdict !== "PASS") problems.push(`the known-PASS surface ${KNOWN_PASS_ROUTE} reported ${r.predicate} ${r.verdict}${r.reason ? ` — ${r.reason}` : ""}: read its evidence before believing any other route's verdict.`);
	}
	console.log(lines.join("\n"));
	expect(problems.join("\n"), `this run may not be read as an F8–F10 board:\n${lines.join("\n")}`).toBe("");
});

/** The shape `report.write()` produces. Narrowed, never cast — CLAUDE.md §6. */
function isRecordFile(value: unknown): value is { records: { route: string; predicate: string; verdict: string; reason?: string }[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		"records" in value &&
		Array.isArray(value.records) &&
		value.records.every((r: unknown) => typeof r === "object" && r !== null && "predicate" in r && "verdict" in r && "route" in r)
	);
}
