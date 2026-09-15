// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Cross-cutting resilience sweep (happy paths). The broad safety net that loads every major
// console page as the `owner` persona and asserts, per page:
//   (a) no redirect to /login (the authed session resolves the route),
//   (b) the document response is < 500 AND no uncaught pageerror / >=500 response fired,
//   (c) the shell `main` landmark renders (proof the page painted, not a blank/crash),
//   (d) — in its own describe, so one verdict never stands for two facts — an axe scan of that
//       surface's `main`.
// This is intentionally shallow-but-wide: it catches broken pages / 500s fast across the whole app
// surface. Deep per-domain behavior lives in the domain specs (connectors/runners/jobs/alerts/…).
//
// THE ROUTE LISTS ARE THE SPEC'S ONLY CLAIM ABOUT WHAT EXISTS, and they had drifted (#4274). They
// carried `/[org]/~/agent`, which is not a route at all — there is no `app/(private)/[org]/~/agent`
// directory; the agent is reached from the topbar, and #4272 owns it. The sweep therefore spent one
// recorded FAIL per run asserting that a page nobody ships renders a `main` landmark. It also missed
// three org routes that DO ship (`evidence`, `support`, `settings/classification`) and one project
// route (`settings/preview`), so four real surfaces had no resilience cover while a fifth that does
// not exist had a permanent red. Both halves are fixed here; the lists are now what the app tree says.
//
// Rule 6 (AUTHORING.md): read-only page loads emit expected 401/analytics noise — we only FAIL on a
// genuine pageerror or a >=500 response, never on console.error / 4xx.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/cross-cutting.spec.ts \
//     --output=test-results/wf-cross-cutting
//
// Isolation: the project surfaces share ONE lazily-seeded, uniquely-named project scoped to the
// persona org. We do NOT call cleanupOrg (sibling QA agents share this persona org in the parallel run).

import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/qa";
import type { ConsoleGuard } from "../helpers/console-errors";
import { requireAxe, scanA11y, type A11yViolation } from "../helpers/a11y";
import { waitForShell } from "../helpers/shell";
import {
	seedCloudIdentity,
	seedDrift,
	seedFinishedDeploy,
	seedJob,
	seedProject,
	type Owner,
	type SeededProject,
} from "../helpers/seed";

/** The persona's Owner id tuple for seeding. */
function ownerId(s: { userId?: string; orgId?: string }): Owner {
	return { userId: s.userId!, orgId: s.orgId! };
}

/** The fatal subset of captured errors: uncaught pageerrors + >=500 responses (per AUTHORING rule 6). */
function fatalErrors(guard: ConsoleGuard): string[] {
	return guard.errors
		.filter((e) => e.kind === "pageerror" || (e.kind === "response" && (e.status ?? 0) >= 500))
		.map((e) => `[${e.kind}] ${e.text}`);
}

/**
 * One line per violation, carrying axe's own check payload.
 *
 * THE PAYLOAD IS THE POINT, not decoration. `color-contrast` puts `fgColor`, `bgColor`,
 * `contrastRatio` and `expectedContrastRatio` in `checks[].data`, and a failure line that reports
 * only an id and a count names no colour pair — so every token change aimed at fixing it is a
 * guess. That is #4099's defect exactly, one scale down, and this helper would have reproduced it:
 * the first version of this function printed `id`, `impact`, `help`, a node count and one selector,
 * and the run that found the evidence page's violation (#4612) named nothing about it. The ratios
 * in that issue had to be derived by hand from `tokens.css` afterwards.
 *
 * `helpers/a11y.ts` has already grouped the nodes by check data, so this is at most a handful of
 * rows per violation rather than one per node.
 */
function describeViolations(violations: A11yViolation[]): string[] {
	return violations.map((v) => {
		const groups = v.groups
			.map((g) => `${g.target} ×${g.count} ${JSON.stringify(g.checks.map((c) => c.data))}`)
			.join("; ");
		const withheld = v.omittedNodes > 0 ? ` (+${v.omittedNodes} node(s) withheld by the cap)` : "";
		return `${v.id} [${v.impact}] ${v.help} — ${v.nodes} node(s)${withheld}: ${groups}`;
	});
}

/**
 * Surfaces with a RECORDED product defect the scan is right to find and this lane cannot fix.
 *
 * Keyed `org:<label>` / `project:<label>`, valued with the ratchet's required `BUG: <what> #<issue>`
 * form. A surface listed here is `test.fixme`'d — it still carries the assertion, so the day the
 * issue is fixed the entry is deleted and the test goes green rather than being rewritten.
 *
 * THE SCOPE PREFIX IS LOAD-BEARING, AND SO IS `debtFor` BEING CALLED FROM BOTH LOOPS. Keyed on the
 * bare label, this map had two silent failures at once, because `ORG_ROUTES` and `PROJECT_ROUTES`
 * share SIX labels — `jobs`, `clusters`, `usage`, `settings/general`, `settings/access`,
 * `settings/activity` (`environments` reads like a seventh and is not: it is project-only). First,
 * only the org loop read the map, so an entry added for a project surface changed nothing at all:
 * TypeScript accepted it, the project test stayed red, and the ratchet then failed on a `{fixme}`
 * the run never produced. Second, on any shared label the entry landed on the WRONG test — a
 * finding on `project settings/access` would have fixme'd the ORG settings/access test, suppressing
 * a real, unrecorded violation on a page nobody meant to exempt. A prefixed key cannot collide and
 * cannot be read by the loop it was not written for.
 *
 * AN ENTRY IS DEBT, NEVER AN EXEMPTION: adding one without an issue number is refused by the
 * ratchet (`/^BUG: .+#\d+/`), and leaving one in place after its issue closes turns the ledger's
 * `{fixme}` into a skip that outlives its subject — which is the failure an exception list makes
 * silently. #4612's own ledger note says to regenerate this file's slice with the fix.
 */
const A11Y_DEBT: Record<string, string> = {
	"org:evidence":
		"BUG: the evidence table paints non-disabled informational text in the disabled ink tier " +
		"(--text-disabled on --surface is 1.95:1 against a 4.5:1 bar), 15 nodes #4612",
};

/** The recorded debt for one surface, or undefined. `scope` is what keeps the two lists apart. */
function debtFor(scope: "org" | "project", label: string): string | undefined {
	return A11Y_DEBT[`${scope}:${label}`];
}

/**
 * Wait until the surface has stopped fetching, so a scan measures the PAGE and not its skeletons.
 *
 * `loadAndAssertShell` returns as soon as the `main` landmark is visible, and every surface in
 * `ORG_ROUTES`/`PROJECT_ROUTES` fetches its rows client-side through React Query — so `main` is
 * visible while the page is still `@repo/ui/skeleton` placeholders. Scanning there measures
 * whichever tree happened to be painted, which is not what the a11y describe below says it
 * measures ("a populated table, a filter bar carrying facet counts") and makes every verdict in it
 * timing-dependent: a surface whose populated tree carries a contrast violation records `passed`
 * in `gate-baseline.json` and then regresses against its own baseline on a slower runner, which
 * the ratchet reports as a NEW failure — a blocked promotion for a defect that was always there.
 *
 * THREE BOUNDED WAITS, NONE OF THEM AN ASSERTION. This is a precondition for a measurement, so a
 * surface that never reaches one of these signals must still be scanned rather than time the test
 * out — each step is capped and its rejection swallowed deliberately. `networkidle` is the same
 * choice `e2e/audit/routes.spec.ts`'s `settle()` makes and for the same stated reason: it is
 * deprecated for assertions and exactly right for "has stopped fetching", and a polling surface
 * (the jobs list refetches on a cadence) never reaches it at all, which is why it is a BUDGET.
 * The skeleton wait is the specific thing axe must not see, named rather than approximated.
 */
async function settleSurface(page: Page): Promise<void> {
	await page.waitForLoadState("load").catch(() => {});
	await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
	// `waitForFunction`, not `expect(...).toHaveCount(0)`: a swallowed expect still records a FAILED
	// step in the trace of a test that passed, which is a false lead in exactly the artifact someone
	// reads when a scan surprises them. This is a wait, so it is written as one.
	await page
		.waitForFunction(() => document.querySelectorAll('[data-slot="skeleton"]').length === 0, undefined, {
			timeout: 6_000,
		})
		.catch(() => {});
}

/**
 * Loads `url`, asserts the document response isn't a 5xx, the route didn't bounce to /login, and the
 * shell `main` landmark painted. Returns after the assertions so the caller can inspect the guard.
 */
async function loadAndAssertShell(page: Page, url: string): Promise<void> {
	const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
	// The navigation document itself must not be a server error.
	if (resp) expect(resp.status(), `document status for ${url}`).toBeLessThan(500);
	await expect(page, `did not redirect to /login for ${url}`).not.toHaveURL(/\/login/);
	await expect(page.getByRole("main"), `main landmark for ${url}`).toBeVisible({ timeout: 25_000 });
}

// The QA dev server SSR is slow under parallel load and Next compiles each route on first hit; the
// a11y sweep pays a scan on top of that nav. Give every test in this file the same headroom the
// domain specs take.
test.beforeEach(() => {
	test.setTimeout(180_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Org-scope routes — no seed needed (the persona org always exists).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ORG_ROUTES: { label: string; path: (slug: string) => string }[] = [
	{ label: "overview", path: (s) => `/${s}` },
	{ label: "connectors", path: (s) => `/${s}/~/connectors` },
	{ label: "runners", path: (s) => `/${s}/~/runners` },
	{ label: "jobs", path: (s) => `/${s}/~/jobs` },
	{ label: "clusters", path: (s) => `/${s}/~/clusters` },
	{ label: "evidence", path: (s) => `/${s}/~/evidence` },
	{ label: "alerts", path: (s) => `/${s}/~/alerts` },
	{ label: "usage", path: (s) => `/${s}/~/usage` },
	{ label: "support", path: (s) => `/${s}/~/support` },
	{ label: "new project", path: (s) => `/${s}/~/new` },
	{ label: "settings/general", path: (s) => `/${s}/~/settings/general` },
	{ label: "settings/billing", path: (s) => `/${s}/~/settings/billing` },
	{ label: "settings/members", path: (s) => `/${s}/~/settings/members` },
	{ label: "settings/teams", path: (s) => `/${s}/~/settings/teams` },
	{ label: "settings/roles", path: (s) => `/${s}/~/settings/roles` },
	{ label: "settings/access", path: (s) => `/${s}/~/settings/access` },
	{ label: "settings/classification", path: (s) => `/${s}/~/settings/classification` },
	{ label: "settings/sso", path: (s) => `/${s}/~/settings/sso` },
	{ label: "settings/activity", path: (s) => `/${s}/~/settings/activity` },
];

test.describe("Cross-cutting — org page resilience sweep", () => {
	for (const route of ORG_ROUTES) {
		test(`${route.label} loads without a 500 / redirect / pageerror`, async ({ owner }) => {
			await loadAndAssertShell(owner.page, route.path(owner.orgSlug));
			expect(fatalErrors(owner.guard), `fatal errors on ${route.label}`).toEqual([]);
		});
	}
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Project-scope routes — one lazily-seeded, deployed project shared across the file (WORKERS=1 keeps
// module state). Seeded uniquely-named; never cleaned up (siblings share the org).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

let seeded: (SeededProject & { jobId: string }) | null = null;

/** Idempotently seeds a connected identity + deployed project + a finished job + drift, once. */
async function ensureProject(owner: { userId?: string; orgId?: string }): Promise<SeededProject & { jobId: string }> {
	if (seeded) return seeded;
	const id = ownerId(owner);
	const identity = await seedCloudIdentity(id, { provider: "aws" });
	const project = await seedProject(id, {
		name: `e2e-xcut-${Date.now()}`,
		cloudIdentityId: identity.id,
		status: "ACTIVE",
	});
	await seedFinishedDeploy(project);
	const job = await seedJob(id, {
		jobType: "DEPLOY",
		status: "SUCCESS",
		projectId: project.projectId,
		envId: project.envId,
		cloudIdentityId: identity.id,
	});
	await seedDrift(project, { inSync: false, drifted: 2 });
	seeded = { ...project, jobId: job.id };
	return seeded;
}

const PROJECT_ROUTES: { label: string; sub: string }[] = [
	{ label: "project root (→architecture)", sub: "" },
	{ label: "architecture", sub: "/architecture" },
	{ label: "environments", sub: "/environments" },
	{ label: "jobs", sub: "/jobs" },
	{ label: "clusters", sub: "/clusters" },
	{ label: "usage", sub: "/usage" },
	{ label: "settings/general", sub: "/settings/general" },
	{ label: "settings/preview", sub: "/settings/preview" },
	{ label: "settings/access", sub: "/settings/access" },
	{ label: "settings/activity", sub: "/settings/activity" },
];

test.describe("Cross-cutting — project page resilience sweep", () => {
	test.beforeEach(async ({ owner }) => {
		await ensureProject(owner);
	});

	for (const route of PROJECT_ROUTES) {
		test(`project ${route.label} loads without a 500 / redirect / pageerror`, async ({ owner }) => {
			const proj = await ensureProject(owner);
			await loadAndAssertShell(owner.page, `/${owner.orgSlug}/${proj.slug}${route.sub}`);
			expect(fatalErrors(owner.guard), `fatal errors on project ${route.label}`).toEqual([]);
		});
	}

	test("job detail page resolves for a seeded job", async ({ owner }) => {
		const proj = await ensureProject(owner);
		await loadAndAssertShell(owner.page, `/${owner.orgSlug}/~/jobs/${proj.jobId}`);
		expect(fatalErrors(owner.guard), "fatal errors on job detail").toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A11y per surface.
//
// WHY THIS IS NOT THE AUDIT'S R5, AND WHY BOTH EARN THEIR KEEP. `e2e/audit/routes.spec.ts` scores
// a11y over the route MANIFEST, in both themes, against fixtures it materialises itself — that is
// the conformance gate and it is the stronger instrument. This sweep scans the same surfaces as the
// QA persona finds them: an org that every sibling spec in this suite has been writing rows into all
// run. The audit's parameterised pass proves a route is clean with one project and one job on it;
// this proves it is still clean with a populated table, a filter bar carrying facet counts, and a
// project someone else's spec left half-configured. Those are different trees, and a violation that
// only the populated one has would be invisible to a scan of the empty one.
//
// SCOPED TO `main`, deliberately. The shell — sidebar, topbar, breadcrumb — is identical on all
// twenty-nine surfaces, so an unscoped scan would report one shell defect twenty-nine times and bury
// the per-route signal underneath it. The shell is the audit's to score once.
//
// `requireAxe()` is the precondition and it is not optional: `helpers/a11y.ts` answers `[]` when
// `@axe-core/playwright` cannot be imported, which is byte-identical to a clean page. Without this,
// every surface below would report a11y-clean on the strength of the scanner being absent — the
// helper's own header says any new gate built on it owes itself this check. It is imported from
// `helpers/`, NOT from `audit/signals.ts` where it used to live: release-gate.yml selects legs from
// changed paths and maps `e2e/audit/**` to the two audit legs alone, so a `flows/ -> audit/` import
// is a dependency its selector cannot see — this file's 29 a11y tests would be broken by a change
// that runs the audit legs green and never runs `qa`. `e2e/helpers/` is a declared SEAM there.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("Cross-cutting — a11y per surface", () => {
	test.beforeAll(async () => {
		await requireAxe();
	});

	for (const route of ORG_ROUTES) {
		test(`${route.label} has no serious/critical a11y violations`, async ({ owner }) => {
			const debt = debtFor("org", route.label);
			if (debt) test.fixme(true, debt);
			await loadAndAssertShell(owner.page, route.path(owner.orgSlug));
			await settleSurface(owner.page);
			const violations = await scanA11y(owner.page, { include: "main" });
			expect(describeViolations(violations), `a11y on ${route.label}`).toEqual([]);
		});
	}

	for (const route of PROJECT_ROUTES) {
		test(`project ${route.label} has no serious/critical a11y violations`, async ({ owner }) => {
			const debt = debtFor("project", route.label);
			if (debt) test.fixme(true, debt);
			const proj = await ensureProject(owner);
			await loadAndAssertShell(owner.page, `/${owner.orgSlug}/${proj.slug}${route.sub}`);
			await settleSurface(owner.page);
			const violations = await scanA11y(owner.page, { include: "main" });
			expect(describeViolations(violations), `a11y on project ${route.label}`).toEqual([]);
		});
	}
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Landmark & title sanity — a couple of explicit anchors so the sweep proves the shell + a titled
// page really rendered (not just that `main` exists).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("Cross-cutting — landmark & title sanity", () => {
	test("the org overview renders the sidebar Overview link", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		// `waitForShell` owns the scoped locator, and `helpers/shell.ts` owns the reason it is
		// scoped — read it there rather than here. This comment used to restate one: that the
		// breadcrumb exposed a second "Overview" as a `role=link`. #4434 removed that role
		// (`BreadcrumbPage` is a bare `<span aria-current="page">` now), so the cause named here
		// was false while the scoping it justified was still right — for a different reason, which
		// is exactly the sentence a reader deciding whether to simplify the wait needs to find.
		await waitForShell(owner.page, 25_000);
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("a metadata-titled page sets its document title (Jobs)", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/jobs`);
		// The root layout's template is `%s — Alethia`, so the whole title is the claim.
		await expect(owner.page).toHaveTitle(/^Jobs — Alethia$/, { timeout: 20_000 });
	});

	test("a settings section titles as '… · Settings'", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/settings/roles`);
		// The assertion says what the test's name says. It used to be `/Roles/`, which passes on a
		// title that dropped the section entirely — the half this test exists to pin.
		await expect(owner.page).toHaveTitle(/^Roles · Settings — Alethia$/, { timeout: 20_000 });
	});
});
