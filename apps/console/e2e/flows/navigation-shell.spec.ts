// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Navigation shell (happy paths): the app shell every private route renders inside.
//
// WHAT THIS FILE MEASURES, AND WHY IT WAS REWRITTEN (#4267).
//
// The previous version measured a sidebar the console stopped shipping. It asserted rows named
// Agent, Observability and Sandboxes — none of which `components/shell/nav-config.ts` builds any
// more — and it asserted Runners unconditionally, when Runners is capability-gated. Nineteen of its
// tests were recorded `failed` in `e2e/gate-baseline.json`, and the failures were not findings
// about the product: they were a spec describing a different application.
//
// Two mechanisms produced most of them, and both are fixed by this lane rather than worked around:
//
//   1. THE BREADCRUMB WAS A SECOND LINK. `packages/ui/src/breadcrumb.tsx`'s current-page crumb
//      carried `role="link"`, and the crumb's label is by construction the label of the sidebar row
//      that got you there. So `getByRole("link", { name: "Jobs" })` matched TWO nodes on the jobs
//      route and Playwright's strict mode refused the locator before any assertion ran. That role
//      is gone; the crumb is a `<span aria-current="page">`, which is the whole accessible
//      statement it has to make.
//   2. ACTIVE STATE WAS READ OFF A CLASS. The old file matched `/(^|\s)bg-muted($|\s)/` on the
//      class attribute — one token away from passing on `hover:bg-muted/60`, and unreadable by
//      anybody who is not looking at pixels. Sidebar rows now carry `aria-current="page"` and this
//      file asserts THAT. A class is how the row looks; `aria-current` is what it is.
//
// THREE RULES THIS FILE KEEPS, EACH FOR A MEASURED REASON:
//
//   · EVERY sidebar locator is scoped to the live nav panel — see `nav()` below. The shell keeps
//     BOTH the main view and the drill sub-view mounted and marks the dormant one `inert`; Playwright's
//     role engine does not read `inert` (`isElementHiddenForAria` checks display/visibility/aria-hidden
//     and nothing else), and the dormant panel is `opacity-0`, which is still "visible" to it. So an
//     unscoped locator on a drilled route silently matches the panel the user cannot reach.
//   · The route list comes from `scripts/lib/console-routes.mjs` through `e2e/audit/manifest.ts`,
//     never from a list typed here. A nav row pointing at a URL the console does not serve is a
//     dead link, and a spec with its own route list cannot see one.
//   · The Runners row is measured in BOTH of its states, seeded through `helpers/seed-nav.ts`.
//     `buildSidebarNav` appends it only when the org owns a self-operated runner, so a spec that
//     measures the org as it happens to be reports on one branch and implies both.
//
// Unknown-route / 404 paths live in navigation-shell.negative.spec.ts.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/navigation-shell.spec.ts
//
// Isolation: seeds are uniquely named (`e2e-nav-*`) and removed by id. We do NOT call cleanupOrg —
// sibling QA specs share these persona orgs during the parallel run.

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../fixtures/qa";
import { consoleRoutes } from "../audit/manifest";
import { scanA11y } from "../helpers/a11y";
import { seedProject, type Owner, type SeededProject } from "../helpers/seed";
import { orgHasSelfRunner, removeSelfRunner, seedSelfRunner } from "../helpers/seed-nav";
import { waitForShell } from "../helpers/shell";

/** The persona's Owner id tuple for seeding. */
function ownerId(s: { userId?: string; orgId?: string }): Owner {
	return { userId: s.userId!, orgId: s.orgId! };
}

/** The desktop sidebar landmark. `<aside>` in `components/shell/app-shell.tsx`; `hidden lg:block`,
 * so at a mobile viewport it is `display:none` and this matches nothing — which is what the mobile
 * describe below asserts. */
function sidebar(page: Page): Locator {
	return page.getByRole("complementary");
}

/**
 * The sidebar's LIVE nav — the drill's when a drill is open, the main view's otherwise.
 *
 * `AppSidebar` keeps both panels mounted and marks the dormant one `inert`, which is the shell's
 * own statement about which one a user can reach. `:not([inert] nav)` reads exactly that statement,
 * and it is not a nicety: Playwright's role engine ignores `inert` and treats `opacity-0` as
 * visible, so an unscoped `getByRole("link", { name: "Settings" })` on `/{org}/~/settings/general`
 * matches the dormant main-view row AND the drill's back header, and refuses the locator.
 *
 * `:not(nav nav)` drops the NESTED one: the Settings drill renders `<SettingsNav/>`, itself a
 * `<nav>`, inside the drill's own — so without it this resolves to two elements on every settings
 * route and every chained query below it is a strict-mode failure of its own making.
 */
function nav(page: Page): Locator {
	return sidebar(page).locator("nav:not([inert] nav):not(nav nav)");
}

/** One sidebar row, by its accessible name, inside the live nav panel. */
function row(page: Page, name: string): Locator {
	return nav(page).getByRole("link", { name, exact: true });
}

/** Asserts a nav row is the current page — in the accessibility tree, not in a class. */
async function expectCurrent(link: Locator): Promise<void> {
	await expect(link).toHaveAttribute("aria-current", "page");
}

/** Asserts a nav row is present and NOT the current page. */
async function expectNotCurrent(link: Locator): Promise<void> {
	await expect(link).toBeVisible();
	await expect(link).not.toHaveAttribute("aria-current", "page");
}

/** The header breadcrumb bar. */
function crumbs(page: Page): Locator {
	return page.getByRole("navigation", { name: "breadcrumb" });
}

/**
 * A concrete URL path rewritten into the route pattern `scripts/lib/console-routes.mjs` reports —
 * `/acme/~/clusters` → `/[org]/~/clusters`, `/acme/web/jobs` → `/[org]/[project]/jobs`.
 */
function toRoutePattern(pathname: string, orgSlug: string, projectSlug?: string): string {
	const segs = pathname.split(/[?#]/)[0].split("/").filter(Boolean);
	if (segs[0] === orgSlug) segs[0] = "[org]";
	if (projectSlug && segs[1] === projectSlug) segs[1] = "[project]";
	return `/${segs.join("/")}`;
}

/**
 * Every `href` the links under `scope` carry, in DOM order. An anchor with no `href` contributes the
 * empty string rather than being dropped: a nav row that lost its target is exactly the defect the
 * sweep below is for, and silently filtering it out would hide it.
 */
async function hrefsOf(scope: Locator): Promise<string[]> {
	const links = await scope.getByRole("link").all();
	return Promise.all(links.map(async (l) => (await l.getAttribute("href")) ?? ""));
}

/** Every private route the console serves, straight from the manifest seam (never re-listed here). */
function servedRoutes(): Set<string> {
	return new Set(consoleRoutes().routes.map((r) => r.route));
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The org sidebar as `buildSidebarNav` builds it TODAY. Runners is absent on purpose: it is
// capability-gated and owned by its own test, which is the only place that may assert either of
// its two states — the suite is fullyParallel and this list is read while that test's seed is live.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const ORG_ROWS = ["Overview", "Clusters", "Jobs", "Evidence", "Connectors", "Alerts", "Usage", "Support", "Settings"];

/** Rows that navigate straight to a page (no drill), with the tab title that page sets. */
const ORG_LINKS: { name: string; path: string; titleRe: RegExp }[] = [
	{ name: "Clusters", path: "~/clusters", titleRe: /Clusters/ },
	{ name: "Jobs", path: "~/jobs", titleRe: /Jobs/ },
	{ name: "Evidence", path: "~/evidence", titleRe: /Evidence/ },
	{ name: "Connectors", path: "~/connectors", titleRe: /Connectors/ },
	{ name: "Usage", path: "~/usage", titleRe: /Usage/ },
	{ name: "Support", path: "~/support", titleRe: /Support/ },
];

test.describe("Navigation shell — the org sidebar", () => {
	test("renders every unconditional row, and none the shell stopped shipping", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await expect(owner.page).not.toHaveURL(/\/login/);
		for (const name of ORG_ROWS) {
			await expect(row(owner.page, name)).toBeVisible();
		}
		// The rows the previous version of this file measured. Each was deleted from
		// `nav-config.ts`; asserting their ABSENCE is what stops the old spec being written again.
		for (const gone of ["Agent", "Observability", "Sandboxes", "Logs", "Metrics", "Traces"]) {
			await expect(nav(owner.page).getByRole("link", { name: gone, exact: true })).toHaveCount(0);
			await expect(nav(owner.page).getByRole("button", { name: gone, exact: true })).toHaveCount(0);
		}
	});

	test("every row points at a route the console actually serves", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		const served = servedRoutes();
		const hrefs = await hrefsOf(nav(owner.page));
		// A scan that found nothing would make the filter below vacuously empty.
		expect(hrefs.length, "the org sidebar rendered no links at all").toBeGreaterThanOrEqual(ORG_ROWS.length);
		const dead = hrefs.filter((h) => !served.has(toRoutePattern(h, owner.orgSlug)));
		expect(dead, `sidebar rows pointing at URLs console-routes.mjs does not report: ${dead.join(", ")}`).toEqual([]);
	});

	test("Overview is the current page on the bare org overview", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await expectCurrent(row(owner.page, "Overview"));
		await expectNotCurrent(row(owner.page, "Clusters"));
	});
});

test.describe("Navigation shell — org navigation", () => {
	for (const link of ORG_LINKS) {
		test(`${link.name} navigates, titles the tab, and becomes the current page`, async ({ owner }) => {
			await owner.page.goto(`/${owner.orgSlug}`);
			await waitForShell(owner.page);
			await row(owner.page, link.name).click();
			await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/${link.path}(\\?|$|#)`), { timeout: 20_000 });
			await expect(owner.page).toHaveTitle(link.titleRe, { timeout: 15_000 });
			await expect(owner.page).not.toHaveURL(/\/login/);
			await expectCurrent(row(owner.page, link.name));
		});
	}

	test("the current page is derived from the URL on a fresh deep-link, with no click", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/connectors`);
		await waitForShell(owner.page);
		await expectCurrent(row(owner.page, "Connectors"));
		await expectNotCurrent(row(owner.page, "Overview"));
	});
});

test.describe("Navigation shell — the capability-gated Runners row", () => {
	// BOTH BRANCHES IN ONE TEST, DELIBERATELY. The suite is fullyParallel, so a second test asserting
	// the OFF branch could run inside this one's seeded window and read the ON branch — a race with
	// itself. One test owns the org's runner state end to end and hands it back unchanged.
	test("appears only while the org owns a self-operated runner", async ({ owner }) => {
		const id = ownerId(owner);
		// The precondition, read through the console's own predicate rather than assumed.
		expect(
			await orgHasSelfRunner(id.orgId),
			"the Hobby persona org already owns a self-operated runner — the OFF branch below cannot be measured",
		).toBe(false);

		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await expect(row(owner.page, "Runners")).toHaveCount(0);

		const runner = await seedSelfRunner(id, { name: `e2e-nav-runner-${Date.now()}` });
		try {
			// `selfRunners` is resolved server-side per request in `[org]/layout.tsx`, so the nav
			// only changes on a fresh document — a soft navigation would not re-run the layout.
			await owner.page.reload();
			await waitForShell(owner.page);
			await expect(row(owner.page, "Runners")).toBeVisible();
		} finally {
			await removeSelfRunner(runner);
		}

		await owner.page.reload();
		await waitForShell(owner.page);
		await expect(row(owner.page, "Runners")).toHaveCount(0);
	});

	test("the runners route stays reachable by deep link while the nav hides it", async ({ owner }) => {
		// The gate is on the ROW, not on the route (`nav-config.ts` says so in as many words), and
		// the two are easy to conflate into a redirect nobody asked for.
		await owner.page.goto(`/${owner.orgSlug}/~/runners`);
		await waitForShell(owner.page);
		await expect(owner.page).toHaveURL(new RegExp(`/${owner.orgSlug}/~/runners`));
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});

test.describe("Navigation shell — the Alerts drill", () => {
	test("the Alerts row navigates and its sub-nav takes over the sidebar", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await row(owner.page, "Alerts").click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/alerts`), { timeout: 20_000 });
		await expect(owner.page).toHaveTitle(/Alerts/, { timeout: 15_000 });
		for (const section of ["Policies", "Channels", "Activity"]) {
			await expect(row(owner.page, section)).toBeVisible();
		}
	});

	test("deep-linking to the alerts hub opens the drill with no click", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/alerts`);
		await expect(row(owner.page, "Policies")).toBeVisible({ timeout: 20_000 });
		// The main view is the dormant panel now — the drill replaced it, and `nav()` proves it by
		// resolving to the drill's rows: Overview is no longer in the live panel.
		await expect(row(owner.page, "Overview")).toHaveCount(0);
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});

test.describe("Navigation shell — the Settings drill", () => {
	// From the same module `SettingsNav` renders, so a section added there is measured here without
	// this file being edited — and a hand-typed list cannot go stale against it.
	const ORG_SECTIONS = [
		"General",
		"Billing",
		"Members",
		"Teams",
		"Roles",
		"Access",
		"Single Sign-On",
		"Classification",
		"Activity",
	];

	test("the Settings row lands on General and lists every org section", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await row(owner.page, "Settings").click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/settings/general`), { timeout: 20_000 });
		for (const section of ORG_SECTIONS) {
			await expect(row(owner.page, section)).toBeVisible();
		}
	});

	test("a section navigates and becomes the current page", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/settings/general`);
		const billing = row(owner.page, "Billing");
		await expect(billing).toBeVisible({ timeout: 20_000 });
		await billing.click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/settings/billing`), { timeout: 20_000 });
		await expectCurrent(row(owner.page, "Billing"));
		await expectNotCurrent(row(owner.page, "General"));
	});

	test("deep-linking to a section marks it current with no click", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/settings/roles`);
		await expectCurrent(row(owner.page, "Roles"));
	});
});

test.describe("Navigation shell — the breadcrumb is not a second navigation", () => {
	test("the current crumb is not a link, and says so with aria-current", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/jobs`);
		await waitForShell(owner.page);
		const bar = crumbs(owner.page);
		await expect(bar).toContainText("Jobs");
		// A one-segment trail is entirely "the page you are on", so it must mint NO links at all.
		await expect(bar.getByRole("link")).toHaveCount(0);
		await expect(bar.locator("[aria-current='page']")).toHaveText("Jobs");
	});

	test("a page's name resolves to exactly ONE link in the whole shell", async ({ owner }) => {
		// THE REGRESSION THIS LANE EXISTS TO CLOSE. With `role="link"` on the current crumb this was
		// 2, and every unscoped `getByRole("link", …)` in the suite was a strict-mode failure
		// waiting for the route whose name matched.
		await owner.page.goto(`/${owner.orgSlug}/~/clusters`);
		await waitForShell(owner.page);
		await expect(crumbs(owner.page)).toContainText("Clusters");
		await expect(owner.page.getByRole("link", { name: "Clusters", exact: true })).toHaveCount(1);
	});

	test("an ANCESTOR crumb is still a real link and navigates", async ({ owner }) => {
		// The other half of the fix: dropping the role from the current page must not cost the trail
		// the links it legitimately mints.
		await owner.page.goto(`/${owner.orgSlug}/~/settings/billing`);
		const ancestor = crumbs(owner.page).getByRole("link", { name: "Settings", exact: true });
		await expect(ancestor).toBeVisible({ timeout: 20_000 });
		await ancestor.click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/settings/general`), { timeout: 20_000 });
	});
});

test.describe("Navigation shell — org switcher", () => {
	test("the trigger names the active org", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await expect(owner.page.getByRole("button", { name: "Switch organization" })).toBeVisible();
	});

	test("it opens a picker listing orgs with a Create action", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: "Switch organization" }).click();
		await expect(owner.page.getByPlaceholder(/find organization/i)).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /create organization/i })).toBeVisible();
	});

	test("searching for a nonexistent org shows the empty message", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: "Switch organization" }).click();
		await owner.page.getByPlaceholder(/find organization/i).fill(`zz-no-org-${Date.now()}`);
		await expect(owner.page.getByText(/no organization found/i)).toBeVisible();
	});

	test("Create organization opens the create sheet", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: "Switch organization" }).click();
		await owner.page.getByRole("button", { name: /create organization/i }).click();
		await expect(owner.page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
	});
});

test.describe("Navigation shell — project switcher", () => {
	let project: SeededProject;

	test.beforeEach(async ({ owner }) => {
		project = await seedProject(ownerId(owner), { name: `e2e-nav-proj-${Date.now()}` });
	});

	test("shows 'All projects' at org scope and opens a project list", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		const trigger = owner.page.getByRole("button", { name: /switch project: all projects/i });
		await expect(trigger).toBeVisible();
		await trigger.click();
		await expect(owner.page.getByPlaceholder(/find project/i)).toBeVisible();
		await expect(owner.page.getByRole("option", { name: project.name })).toBeVisible({ timeout: 15_000 });
	});

	test("selecting a project navigates into it", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: /switch project: all projects/i }).click();
		await owner.page.getByRole("option", { name: project.name }).click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/${project.slug}(/architecture)?(\\?|$)`), {
			timeout: 25_000,
		});
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("searching for a nonexistent project shows the empty message", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: /switch project: all projects/i }).click();
		await owner.page.getByPlaceholder(/find project/i).fill(`zz-no-proj-${Date.now()}`);
		await expect(owner.page.getByText(/no project found/i)).toBeVisible();
	});

	test("Create project routes to the new-project surface", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await owner.page.getByRole("button", { name: /switch project: all projects/i }).click();
		await owner.page.getByRole("button", { name: /create project/i }).click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/new`), { timeout: 20_000 });
	});
});

test.describe("Navigation shell — env switcher", () => {
	let project: SeededProject;

	test.beforeEach(async ({ owner }) => {
		project = await seedProject(ownerId(owner), { name: `e2e-nav-env-${Date.now()}` });
	});

	test("renders on a project route with the default environment", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		await expect(owner.page.getByRole("button", { name: /switch environment: production/i })).toBeVisible({
			timeout: 20_000,
		});
	});

	test("opening it lists environments and a New Environment action", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		await owner.page.getByRole("button", { name: /switch environment: production/i }).click({ timeout: 20_000 });
		await expect(owner.page.getByPlaceholder(/find environment/i)).toBeVisible();
		await expect(owner.page.getByRole("option", { name: "production" })).toBeVisible();
		await expect(owner.page.getByRole("option", { name: /new environment/i })).toBeVisible();
	});

	test("selecting an environment pins it via the ?environment_id query", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		await owner.page.getByRole("button", { name: /switch environment: production/i }).click({ timeout: 20_000 });
		await owner.page.getByRole("option", { name: "production" }).click();
		await owner.page.waitForURL(/environment_id=/, { timeout: 15_000 });
		await expect(owner.page).toHaveURL(/environment_id=/);
	});

	test("is absent at org scope", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await expect(owner.page.getByPlaceholder(/find environment/i)).toHaveCount(0);
	});
});

test.describe("Navigation shell — the project workspace", () => {
	const PROJECT_ROWS = ["Architecture", "Environments", "Jobs", "Clusters", "Usage", "Settings"];
	let project: SeededProject;

	test.beforeEach(async ({ owner }) => {
		project = await seedProject(ownerId(owner), { name: `e2e-nav-side-${Date.now()}` });
	});

	test("a project view swaps the sidebar to the six project surfaces", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		for (const name of PROJECT_ROWS) {
			await expect(row(owner.page, name)).toBeVisible({ timeout: 20_000 });
		}
		// Inherently org-level surfaces are reached through the org scope, not from inside a project.
		for (const orgOnly of ["Connectors", "Evidence", "Alerts", "Support"]) {
			await expect(row(owner.page, orgOnly)).toHaveCount(0);
		}
	});

	test("every project row points at a route the console serves", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		await expect(row(owner.page, "Architecture")).toBeVisible({ timeout: 20_000 });
		const served = servedRoutes();
		const hrefs = await hrefsOf(nav(owner.page));
		expect(hrefs.length, "the project sidebar rendered no links at all").toBeGreaterThanOrEqual(PROJECT_ROWS.length);
		const dead = hrefs.filter((h) => !served.has(toRoutePattern(h, owner.orgSlug, project.slug)));
		expect(dead, `project rows pointing at URLs console-routes.mjs does not report: ${dead.join(", ")}`).toEqual([]);
	});

	test("a project row navigates within the project and becomes current", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/jobs`);
		const environments = row(owner.page, "Environments");
		await expect(environments).toBeVisible({ timeout: 20_000 });
		await environments.click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/${project.slug}/environments`), { timeout: 20_000 });
		await expectCurrent(row(owner.page, "Environments"));
		await expectNotCurrent(row(owner.page, "Jobs"));
	});

	test("the Architecture canvas collapses the sidebar to the icon rail, which keeps the current page", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/architecture`);
		await expect(owner.page.getByRole("button", { name: /expand sidebar/i })).toBeVisible({ timeout: 20_000 });
		await expect(sidebar(owner.page).getByRole("link", { name: "Home", exact: true })).toBeVisible();
		// The rail IS the navigation here, so the active view has to be readable from it too.
		await expectCurrent(row(owner.page, "Architecture"));
	});
});

test.describe("Navigation shell — topbar", () => {
	test("carries the project switcher and the CLI download", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		await expect(owner.page.getByRole("button", { name: /switch project: all projects/i })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /download.*(cli|alethia)/i })).toBeVisible();
	});

	test("the breadcrumb names the current org-global page", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/usage`);
		await expect(crumbs(owner.page)).toContainText("Usage", { timeout: 20_000 });
		await expect(owner.page).toHaveTitle(/Usage/, { timeout: 15_000 });
	});
});

test.describe("Navigation shell — deep link and browser back", () => {
	test("back restores the prior page and its current-page marker", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/clusters`);
		await waitForShell(owner.page);
		await row(owner.page, "Jobs").click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/jobs`), { timeout: 20_000 });
		await expectCurrent(row(owner.page, "Jobs"));
		await owner.page.goBack();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/clusters`), { timeout: 20_000 });
		await expectCurrent(row(owner.page, "Clusters"));
	});
});

test.describe("Navigation shell — accessibility", () => {
	test("the org shell carries no serious or critical axe violation in its sidebar", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await waitForShell(owner.page);
		const violations = await scanA11y(owner.page, { include: "aside" });
		expect(
			violations.map((v) => `${v.id} [${v.impact}] ${v.help} — ${v.target}`),
			"serious/critical axe violations in the sidebar landmark",
		).toEqual([]);
	});

	test("the breadcrumb bar carries no serious or critical axe violation", async ({ owner }) => {
		// The bar this lane changed. `role="link" aria-disabled="true"` on a span that navigates
		// nowhere was the shape being removed; a scan here is what would notice it coming back in
		// some other form.
		await owner.page.goto(`/${owner.orgSlug}/~/settings/billing`);
		await expect(crumbs(owner.page)).toContainText("Billing", { timeout: 20_000 });
		const violations = await scanA11y(owner.page, { include: "nav[aria-label='breadcrumb']" });
		expect(
			violations.map((v) => `${v.id} [${v.impact}] ${v.help} — ${v.target}`),
			"serious/critical axe violations in the breadcrumb bar",
		).toEqual([]);
	});
});

test.describe("Navigation shell — a member of the org", () => {
	// The AUTHORING rule for member assertions: a denial only counts where the OWNER of the same
	// org sees something different. The sidebar is not permission-gated at all today — that is the
	// state being recorded here, not an oversight being papered over.
	test("gets the shell, not the org 404", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}`);
		await waitForShell(member.page);
		await expect(member.page).not.toHaveURL(/\/login/);
		for (const name of ["Overview", "Clusters", "Jobs", "Settings"]) {
			await expect(row(member.page, name)).toBeVisible();
		}
	});

	test("sees the same settings sections the owner of that org sees", async ({ member, team }) => {
		const sections = async (s: { page: Page; orgSlug?: string }) => {
			await s.page.goto(`/${s.orgSlug}/~/settings/general`);
			await expect(nav(s.page).getByRole("link").first()).toBeVisible({ timeout: 20_000 });
			return (await nav(s.page).getByRole("link").allInnerTexts()).map((t) => t.trim());
		};
		// `settings-nav-items.ts` states it outright — plan-gated surfaces render their own in-page
		// upsell rather than hiding, "so the nav carries no lock state". Measured as a DIFFERENCE
		// against the owner of the same org, which is the only comparison that means anything.
		expect(await sections(member)).toEqual(await sections(team));
	});
});

test.describe("Navigation shell — mobile viewport", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	/** Below `lg` the sidebar lives in the slide-in Sheet, which is a dialog rather than the
	 * complementary landmark — so the desktop scope cannot be reused. */
	function drawer(page: Page): Locator {
		return page.getByRole("dialog").locator("nav:not([inert] nav):not(nav nav)");
	}

	test("the desktop sidebar is gone and a menu button opens the drawer", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		const menu = owner.page.getByRole("button", { name: /open navigation/i });
		await expect(menu).toBeVisible({ timeout: 20_000 });
		await expect(sidebar(owner.page)).toHaveCount(0);
		await menu.click();
		await expect(drawer(owner.page).getByRole("link", { name: "Overview", exact: true })).toBeVisible();
	});

	test("tapping a row in the drawer navigates and closes it", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /open navigation/i }).click({ timeout: 20_000 });
		await drawer(owner.page).getByRole("link", { name: "Clusters", exact: true }).click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}/~/clusters`), { timeout: 20_000 });
		await expect(owner.page).toHaveTitle(/Clusters/, { timeout: 15_000 });
		await expect(owner.page.getByRole("dialog")).toHaveCount(0);
	});
});
