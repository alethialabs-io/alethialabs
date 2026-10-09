// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The QA fixture surface every new flow spec imports. Provides persona-authenticated pages built from
// storageState (no live OTP per test — see global-setup.ts) plus automatic latency + console/network
// error collection attached to each test as JSON (rolled up by e2e/reporters/qa-reporter.ts).
//
//   import { test, expect } from "../fixtures/qa";
//   test("...", async ({ owner }) => { await owner.page.goto(`/${owner.orgSlug}/~/connectors`); });
//
// Personas: `owner` (Hobby), `team` (Pro trial), `member` (invited member of the team org). Each is a
// fresh browser context, so mutations in one spec don't leak into another via shared cookies.

import { test as base, type BrowserContext, type Page } from "@playwright/test";
import fs from "node:fs";
import { needsTags, requireCapability } from "../helpers/capabilities";
import { attachConsoleGuard, type ConsoleGuard } from "../helpers/console-errors";
import { waitForHydrationOnNavigation } from "../helpers/hydration";
import { attachPerf, type PerfCollector } from "../helpers/perf";
import { personaMetaPath, type PersonaName, type PersonaRecord } from "../helpers/personas";

export interface PersonaSession extends PersonaRecord {
	page: Page;
	context: BrowserContext;
	guard: ConsoleGuard;
	perf: PerfCollector;
}

interface Registry {
	guards: { name: string; guard: ConsoleGuard }[];
	perfs: { name: string; perf: PerfCollector }[];
}

/** Reads a persona record written by global-setup; throws a clear message if setup didn't run. */
function loadPersona(name: PersonaName): PersonaRecord {
	const p = personaMetaPath();
	if (!fs.existsSync(p)) {
		throw new Error(`No persona metadata at ${p}. Run the suite normally (global-setup creates personas).`);
	}
	const meta = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<Record<PersonaName, PersonaRecord>>;
	const rec = meta[name];
	if (!rec) throw new Error(`Persona "${name}" missing from personas.json — global-setup may have failed for it.`);
	return rec;
}

async function makePersona(
	browser: import("@playwright/test").Browser,
	registry: Registry,
	name: PersonaName,
	hydrationWait: boolean,
): Promise<PersonaSession> {
	const record = loadPersona(name);
	const context = await browser.newContext({ storageState: record.storageState });
	const page = await context.newPage();
	if (hydrationWait) waitForHydrationOnNavigation(page);
	const guard = attachConsoleGuard(page);
	const perf = attachPerf(page);
	registry.guards.push({ name, guard });
	registry.perfs.push({ name, perf });
	return { ...record, page, context, guard, perf };
}

export const test = base.extend<{
	hydrationWait: boolean;
	qa: Registry;
	capabilities: void;
	owner: PersonaSession;
	team: PersonaSession;
	member: PersonaSession;
}>({
	// EVERY `goto`/`reload` WAITS FOR THE PAGE TO HYDRATE (#5849) — see `untilPageHydrated`. Since
	// #5786 a full load hydrates the server's HTML in passes, and a spec that acts on the first paint
	// races them: six qa specs went red that way on unrelated PRs (deploy-jobs, projects, runners,
	// connectors). A test that measures the product's own first-interaction behaviour — a click the
	// moment the content appears — opts out, because this wait would otherwise hide exactly the
	// defect it is there to catch: per navigation with `goto(url, { waitUntil: "commit" })`, or for a
	// whole describe with `test.use({ hydrationWait: false })`.
	hydrationWait: [true, { option: true }],
	// THE CAPABILITY GATE. A test tagged `@needs:<capability>` runs only on a leg that PROMISED it
	// (`ALETHIA_E2E_CAPABILITIES`). In CI an unmet need throws — the tag and the workflow disagree
	// and a red test is the honest report; locally it skips with a reason that says NOT MEASURED.
	// This replaces per-spec `test.skip(!process.env.STRIPE_SECRET_KEY)` guards, whose unset
	// variable turned 35 billing assertions into green skips. See helpers/capabilities.ts.
	capabilities: [
		async ({}, use, testInfo) => {
			for (const cap of needsTags(testInfo.tags)) {
				requireCapability(cap, { skip: (reason) => testInfo.skip(true, reason) });
			}
			await use();
		},
		{ auto: true },
	],
	// Auto fixture: sets up first, tears down last → flushes aggregated perf + errors after all
	// persona contexts (which depend on it) have closed but their record arrays still hold the data.
	qa: [
		async ({}, use, testInfo) => {
			const registry: Registry = { guards: [], perfs: [] };
			await use(registry);
			const perf = registry.perfs.flatMap((p) => p.perf.records);
			const errors = registry.guards.flatMap((g) => g.guard.errors.map((e) => ({ persona: g.name, ...e })));
			await testInfo.attach("qa-perf", { body: JSON.stringify(perf), contentType: "application/json" });
			await testInfo.attach("qa-console-errors", { body: JSON.stringify(errors), contentType: "application/json" });
		},
		{ auto: true },
	],
	// Attach guards to the default page too (public/onboarding specs use it directly).
	page: async ({ page, qa, hydrationWait }, use) => {
		if (hydrationWait) waitForHydrationOnNavigation(page);
		qa.guards.push({ name: "page", guard: attachConsoleGuard(page) });
		qa.perfs.push({ name: "page", perf: attachPerf(page) });
		await use(page);
	},
	owner: async ({ browser, qa, hydrationWait }, use) => {
		const s = await makePersona(browser, qa, "ownerHobby", hydrationWait);
		await use(s);
		await s.context.close();
	},
	team: async ({ browser, qa, hydrationWait }, use) => {
		const s = await makePersona(browser, qa, "ownerTeam", hydrationWait);
		await use(s);
		await s.context.close();
	},
	member: async ({ browser, qa, hydrationWait }, use) => {
		const s = await makePersona(browser, qa, "member", hydrationWait);
		await use(s);
		await s.context.close();
	},
});

export { expect } from "@playwright/test";
