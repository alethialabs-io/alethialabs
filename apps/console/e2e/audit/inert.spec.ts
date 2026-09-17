// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
//
// R8 — THE LIVE PASS. One verdict per route: does every enabled control on it DO something?
//
// `inert.ts` holds the measurement and states what it can and cannot see; read its header before
// reading a score off this suite. This file owns the route loop, the budget, the ledger join and
// the recording, and it writes `test-results/ui-audit-interaction.json` — the THIRD live artifact,
// joined into `apps/console/scripts/audit-report.mjs` and never pooled with the other two.
//
// ── IT NEVER PRESSES A CONFIRM ──────────────────────────────────────────────────────────────────
//
// `activate()` refuses to click while a dialog or an alertdialog is open, so no click this suite
// makes can be the one inside a confirmation. Beyond that structural guarantee, this file adds the
// ledger rule the census is the static half of:
//
//   · a control REGISTERED in `apps/console/destructive-actions.yaml` for this route IS activated.
//     Its declared confirmation is its effect, and #4266 already proves that confirmation is real;
//   · a control the ledger does NOT know about whose accessible name reads destructive is NEVER
//     activated, and is recorded FAIL `unregistered-destructive`. That is the live twin of the
//     census's "a new delete button nobody declared", and it is a finding either way: either the
//     ledger is short an entry, or a control is wearing a verb it does not carry out.
//
// ── A WITHHELD VERDICT IS NOT A PASS, AND THIS FILE SAYS SO TWICE ───────────────────────────────
//
// `report.notMeasured()` records a cell the run could not measure WITH ITS REASON — a control
// budget blown, a route that rendered no `<main>`, a fixture that never produced the subtree. It is
// NOT MEASURED, which leaves the denominator; it is never an N/A, which is a claim about the page.
//
// And a file of nothing but NOT MEASURED must not read as a clean board, so the LAST test fails
// when fewer than `MIN_MEASURED` routes were actually driven. A run whose fixtures all stopped
// seeding would otherwise report 40 green tests having activated nothing at all.

import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

import { closeDb } from "../helpers/db";
import { materialize, restoreContext, resolveOrgSlug, resolveOwner, saveContext, seedRouteFixtures, type AuditContext } from "./context";
import {
	activate,
	emptinessProblems,
	enumerateControls,
	interactionControl,
	measureQuiescence,
	OVERLAY_SELECTOR_WITHOUT_MENUS,
	preActivationExclusion,
	recover,
	resolve,
	type DisabledControl,
	type EnumeratedControl,
	type Observation,
} from "./inert";
import { consoleRoutes, repoRoot, type RouteRecord } from "./manifest";
import { createReport } from "./report";

/**
 * How many controls one route may cost before the run stops and says so.
 *
 * Every control is a click plus up to a one-second window plus, when it moved the page, a reload.
 * A route with 140 of them is not a slower measurement, it is a measurement the leg cannot afford —
 * and the honest report of that is NOT MEASURED WITH THE COUNT, never a PASS over the first 60. A
 * budget that silently truncates is a denominator nobody can see.
 */
const CONTROL_BUDGET = 60;

/**
 * The shell chrome's scope. Measured ONCE, under `/[org]`.
 *
 * `components/shell/app-shell.tsx` puts the sidebar in an `<aside>` and `topbar.tsx` the header in
 * a `<header>`; everything else the shell offers is inside one of the two. Scoring them on every
 * route would record the same forty verdicts forty times and let one broken sidebar button fail
 * every page in the console.
 *
 * ⚠ IT IS A LIST, AND `enumerateControls()` DISTRIBUTES IT rather than interpolating it. See
 * `controlSelector()` in `inert.ts`: `` `${scope} button` `` on this value is `header, aside button`,
 * which CSS reads as a two-item selector LIST — the header's own buttons vanish and the `<header>`
 * element itself is enumerated as one unnamed control. The chrome pass would have measured one
 * thing and looked like it worked.
 *
 * ⚠ THE SIDEBAR IS `hidden lg:block` (`components/shell/app-shell.tsx`). The `audit-interaction`
 * project runs at `devices["Desktop Chrome"]`'s 1280px, so the desktop `<aside>` renders and the
 * mobile `<Sheet>` copy of the same nav does not. At a narrower viewport this scope would enumerate
 * nothing from the sidebar and R8 would PASS the chrome on an empty set — which is the "scores only
 * what it renders" bound in `inert.ts`'s header, applied to the shell.
 */
const CHROME_SCOPE = "header, aside";

/** The one route the shell chrome is measured under. */
const CHROME_ROUTE = "/[org]";

/** See the ⚠ below. Raise from the first real run; a fall is a finding. */
const MIN_MEASURED = 1;

const manifest = consoleRoutes();
const report = createReport();
const ctx: AuditContext = { orgSlug: "", owner: { userId: "", orgId: "" } };

/** Per-route diagnostics the step summary prints, so the floor above can be raised from evidence. */
const measuredRoutes: { route: string; verdict: string; enumerated: number; inert: number }[] = [];

// ── the destructive ledger, through the census's own reader ─────────────────────────────────────

interface LedgerControl {
	route: string;
	control?: { role?: string; name?: string };
}

/**
 * The registry, read by `scripts/check-destructive-actions.mjs` in a subprocess.
 *
 * A subprocess rather than an import, for the reason `manifest.ts` and `destructive.spec.ts` both
 * give: a Playwright spec is transformed to CJS and the census is ESM. It RAISES rather than
 * returning `[]` — a run that could not read the ledger would activate every destructive control in
 * the console believing none of them were registered.
 */
function destructiveLedger(): LedgerControl[] {
	const census = path.join(repoRoot(), "scripts", "check-destructive-actions.mjs");
	let raw: string;
	try {
		raw = execFileSync(process.execPath, [census, "--registry-json"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	} catch (err) {
		throw new Error(`the destructive-action registry could not be read, so R8 cannot tell a registered control from an undeclared one and MUST NOT guess.\n  seam: ${census}\n  ${String(err)}`);
	}
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || !("controls" in parsed) || !Array.isArray(parsed.controls) || parsed.controls.length === 0) {
		throw new Error(`${census} --registry-json produced no controls`);
	}
	return parsed.controls.filter((c): c is LedgerControl => typeof c === "object" && c !== null && "route" in c && typeof c.route === "string");
}

const LEDGER = destructiveLedger();

/**
 * Whether this route's ledger declares a control by this name.
 *
 * Matched on the entry's LITERAL PREFIX, the way `destructive.spec.ts` resolves its triggers: a
 * ledger name carrying a `<placeholder>` is a template, and everything before the placeholder is
 * the part the product really renders.
 */
export function isRegisteredDestructive(route: string, name: string): boolean {
	const needle = name.toLowerCase();
	return LEDGER.some((entry) => {
		if (entry.route !== route) return false;
		const declared = entry.control?.name;
		if (declared === undefined) return false;
		const literal = declared.split("<")[0].trim().toLowerCase();
		return literal.length > 0 && needle.includes(literal);
	});
}

// ── one route ───────────────────────────────────────────────────────────────────────────────────

/** The evidence a route's verdict carries. Counts are of what was ENUMERATED, never of what exists. */
interface RouteEvidence {
	enumerated: number;
	activated: number;
	inert: { control: string; origin: string }[];
	notActivated: { control: string; why: string }[];
	disabled: { withReason: number; noReason: number };
	external: number;
	/** False when the route chattered and "a request happened" could not be attributed to a click. */
	networkSignal: boolean;
	/**
	 * The scopes this verdict covers, EACH WITH WHAT IT FOUND — `main`, and `chrome` on the one
	 * route that measures it.
	 *
	 * The count is here and not implied because a bare `["main", "chrome"]` is a claim that the
	 * chrome was covered, and a scope that enumerated nothing looks exactly like a scope that
	 * enumerated nothing wrong. The sidebar is `hidden lg:block`, so a viewport change alone would
	 * empty it; `chrome: 0` in the committed evidence is the only thing that would say so.
	 */
	enumeratedFrom: { scope: string; enumerated: number }[];
}

/**
 * Drive every control in one enumeration, recovering the page between activations.
 *
 * Returns the observations. The page is left on `url`, loaded and clean.
 */
async function driveControls(page: Page, route: string, url: string, controls: EnumeratedControl[], networkUsable: boolean): Promise<Observation[]> {
	const observations: Observation[] = [];
	for (const control of controls) {
		const excluded = preActivationExclusion(control.name, isRegisteredDestructive(route, control.name));
		if (excluded !== null) {
			observations.push({ control, effect: null, excluded, dirtied: false });
			continue;
		}
		const locator = await resolve(page, control);
		if (locator === null) {
			observations.push({ control, effect: null, excluded: "control-list-moved", dirtied: false });
			continue;
		}
		const seen = await activate(page, locator, {
			networkUsable,
			overlaySelector: control.origin === "menu" ? OVERLAY_SELECTOR_WITHOUT_MENUS : undefined,
		});
		observations.push({
			control,
			effect: seen.effect,
			...(seen.fileChooser ? { excluded: "opens-file-chooser" as const } : {}),
			dirtied: seen.dirtied,
		});
		const clean = await recover(page);
		if (seen.dirtied || !clean || page.url() !== url) {
			await page.goto(url, { waitUntil: "domcontentloaded" });
		}
	}
	return observations;
}

/**
 * Score one route, and record exactly one R8 cell for it.
 *
 * Four outcomes, and the difference between the last two is the whole point of `notMeasured()`:
 * PASS, FAIL, N/A (a claim about the PAGE — it redirects, or offers nothing to press) and NOT
 * MEASURED (a claim about the RUN — the budget, a missing `<main>`, a route that would not load).
 */
async function auditRoute(route: RouteRecord, page: Page): Promise<void> {
	if (route.isRedirectOnly) {
		report.record({ route: route.route, url: route.route, predicate: "R8", verdict: "N/A", reason: "redirect-only" });
		return;
	}

	let url: string;
	try {
		url = materialize(route, ctx);
	} catch (err) {
		report.notMeasured({ route: route.route, url: route.route, predicate: "R8", reason: `the route could not be materialised: ${err instanceof Error ? err.message : String(err)}` });
		return;
	}

	await page.goto(url, { waitUntil: "domcontentloaded" });

	const main = await enumerateControls(page, "main", "main");
	if (!main.hasMain) {
		report.notMeasured({ route: route.route, url, predicate: "R8", reason: "the page rendered no `<main>` — nothing was enumerated, which is a claim about this run and not about the page" });
		return;
	}

	// THE SHELL CHROME, MEASURED ONCE. Every route renders it; scoring it on each would record the
	// same verdicts forty times and let one sidebar button fail the whole console.
	const chrome = route.route === CHROME_ROUTE ? await enumerateControls(page, CHROME_SCOPE, "chrome") : null;

	const controls = [...main.controls, ...(chrome?.controls ?? [])];
	const disabled: DisabledControl[] = [...main.disabled, ...(chrome?.disabled ?? [])];
	const external = [...main.external, ...(chrome?.external ?? [])];
	const enumeratedFrom = [
		{ scope: "main", enumerated: main.controls.length },
		...(chrome === null ? [] : [{ scope: "chrome", enumerated: chrome.controls.length }]),
	];

	if (controls.length === 0 && external.length === 0) {
		report.record({ route: route.route, url, predicate: "R8", verdict: "N/A", reason: "no-enabled-controls" });
		return;
	}
	if (controls.length > CONTROL_BUDGET) {
		report.notMeasured({
			route: route.route,
			url,
			predicate: "R8",
			reason: `control-budget-exceeded (${controls.length} enabled controls, budget ${CONTROL_BUDGET})`,
			evidence: { enumerated: controls.length, budget: CONTROL_BUDGET, enumeratedFrom },
		});
		return;
	}

	const quiescence = await measureQuiescence(page);
	const observations = await driveControls(page, route.route, url, controls, quiescence.quiet);

	// A menu is a control whose effect is more controls. Depth ONE only, and declared: an item that
	// opens a submenu is enumerated and activated like any other, but its submenu is not descended
	// into. Two levels would multiply a route's cost by the fan-out of its deepest menu, and the
	// shapes this console builds are one level.
	const menuObservations = await driveMenus(page, route.route, url, observations, quiescence.quiet);

	const all = [...observations, ...menuObservations];
	const inert = all.filter((o) => o.excluded === undefined && o.effect === null);
	const unregistered = all.filter((o) => o.excluded === "unregistered-destructive");
	const evidence: RouteEvidence = {
		enumerated: all.length,
		activated: all.filter((o) => o.excluded === undefined).length,
		inert: inert.map((o) => ({ control: `${o.control.role} "${o.control.name}"`, origin: o.control.origin })),
		notActivated: all
			.filter((o) => o.excluded !== undefined)
			.map((o) => ({ control: `${o.control.role} "${o.control.name}"`, why: String(o.excluded) })),
		disabled: {
			withReason: disabled.filter((d) => d.reason === "disabled-with-reason").length,
			noReason: disabled.filter((d) => d.reason === "disabled-no-reason").length,
		},
		external: external.length,
		networkSignal: quiescence.quiet,
		enumeratedFrom,
	};

	// An external link PASSES on a real href and is never clicked, so a route of nothing but
	// external links has been measured — it just has nothing that could be inert.
	const failed = inert.length > 0 || unregistered.length > 0;
	report.record({ route: route.route, url, predicate: "R8", verdict: failed ? "FAIL" : "PASS", evidence });
	measuredRoutes.push({ route: route.route, verdict: failed ? "FAIL" : "PASS", enumerated: evidence.enumerated, inert: inert.length + unregistered.length });
}

/**
 * Enumerate and drive the depth-1 items of every menu a control opened.
 *
 * A menu item is re-reached by re-opening its menu, because a menu closes when an item is
 * activated — which is also why a menu item's effect is measured against
 * `OVERLAY_SELECTOR_WITHOUT_MENUS`: counting the menu that just closed against the dialog that just
 * opened arithmetics a working item down to zero.
 */
async function driveMenus(page: Page, route: string, url: string, observations: Observation[], networkUsable: boolean): Promise<Observation[]> {
	const openers = observations.filter((o) => o.effect === "overlay" && o.excluded === undefined);
	const out: Observation[] = [];
	let budgetLeft = CONTROL_BUDGET - observations.length;
	for (const opener of openers) {
		if (budgetLeft <= 0) break;
		await page.goto(url, { waitUntil: "domcontentloaded" });
		const locator = await resolve(page, opener.control);
		if (locator === null) continue;
		await locator.click({ force: true, noWaitAfter: true, timeout: 2_000 }).catch(() => {});
		await page.waitForTimeout(250);
		if ((await page.locator('[role="menu"]').count()) === 0) {
			await recover(page);
			continue;
		}
		const items = await enumerateControls(page, '[role="menu"]', "menu");
		for (const item of items.controls.slice(0, budgetLeft)) {
			budgetLeft -= 1;
			const withOpener: EnumeratedControl = { ...item, opener: opener.control.name };
			// THE SAME FUNCTION the route loop asks — see `preActivationExclusion`'s header. A menu
			// item is where the console puts most of its deletes, so a menu loop with its own copy
			// of the rule is the copy that would go stale unnoticed.
			const excluded = preActivationExclusion(item.name, isRegisteredDestructive(route, item.name));
			if (excluded !== null) {
				out.push({ control: withOpener, effect: null, excluded, dirtied: false });
				continue;
			}
			// Re-open the menu for THIS item: the previous item's activation closed it.
			if ((await page.locator('[role="menu"]').count()) === 0) {
				await page.goto(url, { waitUntil: "domcontentloaded" });
				const again = await resolve(page, opener.control);
				if (again === null) break;
				await again.click({ force: true, noWaitAfter: true, timeout: 2_000 }).catch(() => {});
				await page.waitForTimeout(250);
			}
			const itemLocator = await resolve(page, item);
			if (itemLocator === null) {
				out.push({ control: withOpener, effect: null, excluded: "control-list-moved", dirtied: false });
				continue;
			}
			const seen = await activate(page, itemLocator, { networkUsable, overlaySelector: OVERLAY_SELECTOR_WITHOUT_MENUS });
			out.push({ control: withOpener, effect: seen.effect, ...(seen.fileChooser ? { excluded: "opens-file-chooser" as const } : {}), dirtied: seen.dirtied });
			await recover(page);
		}
		await page.goto(url, { waitUntil: "domcontentloaded" });
	}
	return out;
}

// ── the suite ───────────────────────────────────────────────────────────────────────────────────

test.beforeAll(async ({ browser }) => {
	const page = await browser.newPage();
	ctx.orgSlug = await resolveOrgSlug(page);
	ctx.owner = await resolveOwner(ctx.orgSlug);
	await seedRouteFixtures(ctx);
	saveContext(ctx);

	// THE POSITIVE CONTROL RUNS BEFORE A SINGLE ROUTE IS SCORED, and the run consults it.
	//
	// #3804 is the reason this is not simply a test in `predicate-selftest.spec.ts`: R3's own
	// control was failing on `dev` while the same job published R3 FAILs for two real routes — a
	// verdict from an instrument already known to be broken. `withhold()` rewrites every later R8
	// verdict to NOT MEASURED, whatever this file computes.
	const broken = await interactionControl(page);
	if (broken.length > 0) {
		report.withhold(["R8"], `R8's positive control is red, so nothing it measures can be believed: ${broken.join(" · ")}`);
	}
	await page.close();
});

test.beforeEach(() => {
	restoreContext(ctx);
});

for (const route of manifest.routes) {
	test(`R8 ${route.route}`, async ({ page }) => {
		await auditRoute(route, page);
	});
}

test.afterAll(async () => {
	// A runKey of "" is a run whose `beforeAll` never resolved an org. Writing under it would merge
	// with any other such file and describe an organisation nobody can name.
	if (ctx.orgSlug) report.write(ctx.orgSlug, "ui-audit-interaction.json");
	await closeDb();
});

// ── the guard on this suite's own emptiness ─────────────────────────────────────────────────────
//
// ⚠ `MIN_MEASURED` is 1 on this first landing and that is deliberately weak, for the reason
// `destructive.spec.ts` states about its own floor: the honest number is the one the FIRST REAL RUN
// produces, and a floor invented before the measurement is a number nobody could defend. The line
// this test prints on every run is what the next reader raises it to; a later fall is the finding.

test("R8 measured something — a full column of NOT MEASURED is not a pass", () => {
	// READ THE MERGED FILE, NOT THIS WORKER'S BUFFER. Playwright discards a worker after a test
	// times out and starts the next test in a fresh one, and each worker holds its own `Report` —
	// so an in-memory count would be the LAST worker's records and would fail this floor for a
	// reason that has nothing to do with what the run measured. `write()` merges on the run key.
	const file = ctx.orgSlug ? report.write(ctx.orgSlug, "ui-audit-interaction.json") : null;
	expect(file, "no org slug was resolved, so this run measured nothing and cannot be scored").not.toBeNull();
	if (file === null) return;
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	const records = isRecordFile(parsed) ? parsed.records.filter((r) => r.predicate === "R8") : [];

	const measured = records.filter((r) => r.verdict === "PASS" || r.verdict === "FAIL");
	const notMeasured = records.filter((r) => r.verdict === "NOT MEASURED");
	const na = records.filter((r) => r.verdict === "N/A");
	const withheld = report.withheld().get("R8");

	const detail = [
		...notMeasured.map((r) => `  · ${r.route}: NOT MEASURED — ${r.reason}`),
		...measuredRoutes.filter((r) => r.verdict === "FAIL").map((r) => `  · ${r.route}: FAIL — ${r.inert} of ${r.enumerated} enabled controls did nothing`),
	].join("\n");

	// Printed pass or fail. The three counts MUST sum to the route set: a route that is neither
	// measured, nor withheld, nor N/A went unrecorded, and a report describing fewer routes than
	// exist is the failure this line exists to make impossible to miss.
	console.log(
		`R8: ${measured.length} measured, ${notMeasured.length} not measured, ${na.length} N/A ` +
			`= ${measured.length + notMeasured.length + na.length} of ${manifest.routes.length} routes.\n${detail}`,
	);

	// The three questions live in `emptinessProblems()` — a pure function, so a node harness can
	// drive the floor in both directions rather than the floor being a line only its own suite can
	// ever exercise. The assertion here is that it found nothing; the reasons it prints are its own.
	const problems = emptinessProblems(records, withheld, manifest.routes.length, MIN_MEASURED);
	expect(problems.join("\n"), `this run may not be read as an R8 board:\n${detail}`).toBe("");
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
