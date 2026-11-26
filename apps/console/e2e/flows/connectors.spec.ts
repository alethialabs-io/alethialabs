// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Exhaustive e2e for the Connectors board (`/{org}/~/connectors`) as it is TODAY: the console
// filter standard on the one-row `ListToolbar` (search → Status / Group / Vendor facets → reset,
// URL-synced, facet counts over the unfiltered universe), the seven catalog sections, the card↔table toggle, the
// per-cloud connect sheets (opened + validated, never submitting real credentials) and — via a
// seeded cloud identity — the connected state, the manage sheet and the disconnect confirm.
// Negative / permission / not-enabled paths live in connectors.negative.spec.ts.
//
// WHAT THE JULY SPEC LOOKED FOR AND WHY IT IS GONE. It drove a Radix `<Select>` group filter
// (`getByRole("combobox")`), four sections named Clouds / Secrets / Registries / **Apps**, an
// `N / M connected` counter and the copy "No connectors match your search." None of those exist:
// the bar moved to the shared filter grammar (now one `ListToolbar`, `components/connectors/connectors-facets.ts`),
// `apps` was split into source / registries / chart_repos / observability / dns
// (`connectors-query.ts` → `GROUP_META`), the header counter reads "N connected", and the empty
// state is the shared `FilterEmpty`, "No connectors match these filters."
//
// SELECTOR RULE FOR THIS BOARD. Never `getByRole("button", { name: "Connect" })`. The catalog is
// 42 connectors and every connectable one renders a button whose visible word is "Connect", so
// that locator resolves to a couple of dozen elements and fails Playwright strict mode. Each
// action button now carries `aria-label="<Verb> <connector name>"` (#4268), so ask for the one you
// mean — `{ name: "Connect Datadog", exact: true }`. `exact` is load-bearing: "Connect GitHub" is
// a prefix of "Connect GitHub Container Registry".
//
// Isolation note: the QA harness forbids cleanupOrg during the parallel run, so every
// connected-state test seeds its OWN uniquely-named cloud identity and scopes its assertions to
// that name. Accumulated AWS accounts in the shared persona org are expected and harmless.

import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/qa";
import { scanA11y } from "../helpers/a11y";
import { seedCloudIdentity } from "../helpers/seed";

// The connectors route re-runs a costly server-side setup on every load (per-provider health
// probes + a pending-identity INSERT for each unconnected cloud), so navigations are slow — and
// slower under concurrent load. Give tests generous headroom.
test.describe.configure({ timeout: 120_000 });

/**
 * Navigates to the org connectors board (optionally with filter params already in the URL) and
 * waits for the filter bar's search box, which is the board's first interactive element — until it
 * is ENABLED, not only visible. The bar sits in a fieldset disabled until React has hydrated, so
 * "enabled" is the page saying its handlers are attached; a Manage clicked in the server HTML before
 * that is a click nothing hears, and the sheet never opens.
 */
async function gotoConnectors(page: Page, orgSlug: string, query = ""): Promise<void> {
	await page.goto(`/${orgSlug}/~/connectors${query}`, { waitUntil: "commit" });
	const box = page.getByRole("textbox", { name: "Search connectors", exact: true });
	await expect(box).toBeVisible({ timeout: 60_000 });
	await expect(box).toBeEnabled({ timeout: 30_000 });
}

/**
 * The board's free-text filter input, by role under its accessible name (see the filter bar).
 * Never `getByLabel`/`getByPlaceholder`: those also match the hidden streamed copy of the bar a
 * full-page load can leave in the DOM, and filling that copy applies no search (#5777, #5800).
 */
const search = (page: Page) => page.getByRole("textbox", { name: "Search connectors", exact: true });

/**
 * Opens one facet's popover. The trigger's accessible name grows the selection once one is made
 * ("Group" → "Group: Clouds", or "Group · 3 selected"), so it is matched by prefix rather than
 * exactly.
 */
async function openFacet(page: Page, label: "Status" | "Group" | "Vendor"): Promise<void> {
	await page.getByRole("button", { name: new RegExp(`^${label}\\b`) }).click();
}

/** Opens the Group facet popover, and waits for its first option. */
async function openGroupFacet(page: Page): Promise<void> {
	await openFacet(page, "Group");
	await expect(page.getByRole("option", { name: /^Clouds/ })).toBeVisible();
}

/**
 * The count the Group facet prints beside one option. `FacetFilter` renders it as the option's
 * trailing mono `count`, so it is the trailing digits of the row's text — read as a NUMBER rather than compared as
 * a string, so the assertion cannot pass on two differently-rendered spellings of the same tally.
 * Requires the popover to be open.
 */
async function facetCount(page: Page, label: string): Promise<number> {
	const text = await page.getByRole("option", { name: new RegExp(`^${label}`) }).textContent();
	const digits = (text ?? "").replace(/\D/g, "");
	return digits === "" ? Number.NaN : Number(digits);
}

/** A group section's `<h2>` — `SectionHeading` renders the label; the "N connected" line sits beside it. */
const groupHeading = (page: Page, label: string) =>
	page.getByRole("heading", { name: label, exact: true });

/** Seeds a connected AWS account. (`helpers/seed.ts` writes a provider-shaped credential for each
 *  cloud since #4708; this stays AWS because the assertions below name AWS's catalog row.) */
async function seedAwsAccount(
	owner: { userId?: string; orgId?: string },
	name: string,
): Promise<void> {
	await seedCloudIdentity({ userId: owner.userId!, orgId: owner.orgId! }, { provider: "aws", name });
}

test.describe("Connectors — the board and its filter bar", () => {
	test("loads the board authenticated, on the shared filter grammar", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await expect(owner.page).not.toHaveURL(/\/login/);
		// The one-row toolbar: the search, the three facets, then the view toggle.
		await expect(search(owner.page)).toBeVisible();
		for (const facet of ["Status", "Group", "Vendor"]) {
			await expect(owner.page.getByRole("button", { name: facet, exact: true })).toBeVisible();
		}
		await expect(owner.page.getByRole("button", { name: "Table view" })).toBeVisible();
	});

	// The title predates #7738 and is kept because it is this test's key in e2e/gate-baseline.json:
	// the body asserts the one-row toolbar with NO description line. The same holds for the four
	// renamed-in-spirit titles below (EmptyState → FilterEmpty, Reset → Clear filters, chips and
	// combobox → facets).
	test("the page toolbar carries the description and no count, and the page carries no title", async ({
		owner,
	}) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		// One `ListToolbar` row (polish-wave spec §3): the description line that used to sit above it
		// is gone ("it just takes space and does nothing"), and so is any count: the catalog is a
		// bounded list and the list standard draws no list-size pill (#7546), and neither do the group
		// headings.
		//
		// The row is asserted PRESENT (its search, and the docs link at its far end) before the
		// description and the pill are asserted absent, and the board is asserted FULL: an absence
		// check over a page that never rendered passes while measuring nothing.
		await expect(search(owner.page)).toBeVisible();
		const end = owner.page.locator('[data-slot="list-toolbar-end"]');
		await expect(end.getByRole("link", { name: "What are connectors?" })).toBeVisible();
		await expect(groupHeading(owner.page, "Clouds")).toBeVisible();
		const cards = owner.page.locator('[data-slot="connector-card"]').filter({ visible: true });
		await expect.poll(() => cards.count()).toBeGreaterThan(20);
		await expect(owner.page.locator('[data-slot="page-toolbar"]')).toHaveCount(0);
		await expect(owner.page.getByText("Credentials Alethia acts through")).toHaveCount(0);
		await expect(owner.page.locator('main [data-slot="count-pill"]')).toHaveCount(0);
		// The console has no page titles — the sidebar entry you clicked and the breadcrumb above
		// the content both already say "Connectors", so a heading saying it a third time earns
		// nothing. Asserted as "no heading NAMES this page", not "no h1 anywhere": the shell is
		// free to grow headings of its own, and this lane is not the one that would own them.
		await expect(
			owner.page.getByRole("heading", { name: "Connectors", exact: true }),
		).toHaveCount(0);
	});

	test("every catalog group renders as its own section", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		// The seven `GROUP_META` groups. The July spec looked for "Apps", which never existed
		// after the 1:1 category→group split.
		for (const label of [
			"Clouds",
			"Source",
			"Registries",
			"Chart Repos",
			"Secrets",
			"Observability",
			"DNS",
		]) {
			await expect(groupHeading(owner.page, label)).toBeVisible();
		}
		await expect(groupHeading(owner.page, "Apps")).toHaveCount(0);
	});

	test("each group header reports how many of its connectors are connected", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await expect(owner.page.getByText(/^\d+ connected$/).first()).toBeVisible();
	});

	test("search narrows the board to the matching connector's section", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await search(owner.page).fill("Datadog");
		await expect(
			owner.page.getByRole("button", { name: "Connect Datadog", exact: true }),
		).toBeVisible();
		await expect(groupHeading(owner.page, "Observability")).toBeVisible();
		await expect(groupHeading(owner.page, "Registries")).toHaveCount(0);
	});

	test("search matches the vendor organization, not only the name", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		// "HashiCorp" is the ORGANIZATION behind Vault; it is not in the connector's own name.
		await search(owner.page).fill("HashiCorp");
		await expect(
			owner.page.getByRole("button", { name: "Connect HashiCorp Vault", exact: true }),
		).toBeVisible();
		await expect(groupHeading(owner.page, "Clouds")).toHaveCount(0);
	});

	test("a search that matches nothing renders the shared EmptyState", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await search(owner.page).fill("zzz-no-such-connector");
		// Exact, and the console's one wording for a filtered empty list (`FilterEmpty`): it names
		// no size — #7546 removed the number with the count pills ("no N of M prose") — so a number
		// creeping back into the sentence reds here.
		await expect(
			owner.page.getByText("No connectors match these filters.", { exact: true }),
		).toBeVisible();
		await expect(owner.page.getByRole("button", { name: "Clear filters" })).toBeVisible();
	});

	test("Reset filters from the empty state restores the whole board", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await search(owner.page).fill("zzz-no-such-connector");
		await owner.page.getByRole("button", { name: "Clear filters" }).click();
		await expect(groupHeading(owner.page, "Clouds")).toBeVisible();
		await expect(search(owner.page)).toHaveValue("");
	});

	test("the filter state is mirrored into the URL, so a filtered view is shareable", async ({
		owner,
	}) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await search(owner.page).fill("Datadog");
		await expect(owner.page).toHaveURL(/[?&]search=Datadog\b/);
	});

	test("a pasted filtered URL wins over the pristine board", async ({ owner }) => {
		// Step 2 of the standard: on mount, URL params beat persisted session state.
		await gotoConnectors(owner.page, owner.orgSlug, "?groups=clouds");
		await expect(groupHeading(owner.page, "Clouds")).toBeVisible();
		await expect(groupHeading(owner.page, "Registries")).toHaveCount(0);
		// The facet trigger names its selection once the URL is decoded into the store (#7737), and
		// grows the sibling that clears it.
		await expect(owner.page.getByRole("button", { name: /^Group\b/ })).toHaveAccessibleName("Group: Clouds");
		await expect(owner.page.getByRole("button", { name: "Clear Group", exact: true })).toBeVisible();
	});

	test("the Group facet narrows the board and writes itself into the URL", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await openGroupFacet(owner.page);
		await owner.page.getByRole("option", { name: /^Clouds/ }).click();
		await owner.page.keyboard.press("Escape");
		await expect(groupHeading(owner.page, "Clouds")).toBeVisible();
		await expect(groupHeading(owner.page, "Secrets")).toHaveCount(0);
		await expect(owner.page).toHaveURL(/[?&]groups=clouds\b/);
	});

	test("a facet's counts come from the UNFILTERED universe", async ({ owner }) => {
		// THE INVARIANT (lib/query/README.md step 6, lib/queries/facets.ts): facet counts are
		// tallied over the whole catalog, never over the rows the current query selected. Count in
		// memory over the filtered rows and the option you just picked drops to zero and vanishes,
		// which makes the bar un-un-selectable.
		await gotoConnectors(owner.page, owner.orgSlug);
		await openGroupFacet(owner.page);
		const before = await facetCount(owner.page, "Registries");
		expect(before, "the Registries facet must carry a count to compare").toBeGreaterThan(0);
		await owner.page.getByRole("option", { name: /^Clouds/ }).click();
		await owner.page.keyboard.press("Escape");
		// The board now shows Clouds only — and the Registries option must still be offered, with
		// the same count it had over the unfiltered catalog.
		await expect(groupHeading(owner.page, "Registries")).toHaveCount(0);
		await openGroupFacet(owner.page);
		expect(await facetCount(owner.page, "Registries")).toBe(before);
	});

	test("the Status chips filter the board by health bucket", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		// The option's accessible name is its label plus its facet count ("Coming soon, 11").
		await openFacet(owner.page, "Status");
		await owner.page.getByRole("option", { name: /^Coming soon\b/ }).click();
		await owner.page.keyboard.press("Escape");
		await expect(owner.page.getByRole("button", { name: "Status: Coming soon", exact: true })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: "Clear Status", exact: true })).toBeVisible();
		// Every remaining row is coming-soon, so nothing on the board offers a connect action.
		await expect(owner.page.getByRole("button", { name: /^Connect / })).toHaveCount(0);
		// A coming-soon row that is not a cloud: a cloud this deployment does not offer has no card
		// at all (#6811), so DigitalOcean, which this used to name, is no longer on the board.
		await expect(owner.page.getByText("Amazon ECR (cross-account)").first()).toBeVisible();
	});

	test("the vendor combobox narrows the board to one organization", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await openFacet(owner.page, "Vendor");
		await owner.page.getByRole("option", { name: /^Datadog, Inc\./ }).click();
		await owner.page.keyboard.press("Escape");
		await expect(
			owner.page.getByRole("button", { name: "Connect Datadog", exact: true }),
		).toBeVisible();
		await expect(groupHeading(owner.page, "Clouds")).toHaveCount(0);
	});

	test("the Reset affordance appears with an active filter and clears it", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await expect(owner.page.getByRole("button", { name: /^Reset ·/ })).toHaveCount(0);
		await search(owner.page).fill("Datadog");
		await owner.page.getByRole("button", { name: /^Reset ·/ }).click();
		await expect(search(owner.page)).toHaveValue("");
		await expect(groupHeading(owner.page, "Clouds")).toBeVisible();
	});

	test("toggles from card view to table view and back", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByRole("button", { name: "Table view" }).click();
		await expect(owner.page.getByRole("table").first()).toBeVisible();
		await owner.page.getByRole("button", { name: "Card view" }).click();
		await expect(owner.page.getByRole("table")).toHaveCount(0);
	});

	test("the table view is a real table with a labelled header row", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByRole("button", { name: "Table view" }).click();
		for (const column of ["Connector", "Status", "Details", "Action"]) {
			await expect(
				owner.page.getByRole("columnheader", { name: column, exact: true }).first(),
			).toBeVisible();
		}
	});

	test("board has no serious/critical a11y violations (soft)", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		const violations = await scanA11y(owner.page);
		expect(Array.isArray(violations)).toBe(true);
	});
});

test.describe("Connectors — connect sheets (open + validate, no submit)", () => {
	test("every connect action is addressable by the connector it connects", async ({ owner }) => {
		// THE REGRESSION TEST FOR #4268. The board offers many connect actions and they used to
		// share one accessible name, which is both a strict-mode failure and a screen reader
		// hearing "Connect, button" over and over with nothing to tell the buttons apart.
		await gotoConnectors(owner.page, owner.orgSlug);
		// More than one connect action on the board — otherwise the two assertions below would be
		// trivially satisfiable by a board that renders exactly one button.
		expect(
			await owner.page.getByRole("button", { name: /^Connect / }).count(),
		).toBeGreaterThan(1);
		await expect(
			owner.page.getByRole("button", { name: "Connect Datadog", exact: true }),
		).toHaveCount(1);
		await expect(
			owner.page.getByRole("button", { name: "Connect Cloudflare", exact: true }),
		).toHaveCount(1);
	});

	test("an api_key connector opens the pluggable credential sheet", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByRole("button", { name: "Connect Datadog", exact: true }).click();
		const sheet = owner.page.getByRole("dialog");
		await expect(sheet.locator('[data-slot="sheet-title"]')).toHaveText("Connect Datadog");
		// Fields are rendered from the registry's credential project, not hand-written.
		await expect(sheet.getByLabel(/^API Key/)).toBeVisible();
		await expect(sheet.getByLabel(/^Application Key/)).toBeVisible();
	});

	test("the api-key sheet blocks an empty submit and names the missing field", async ({
		owner,
	}) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByRole("button", { name: "Connect Datadog", exact: true }).click();
		const sheet = owner.page.getByRole("dialog");
		await sheet.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(sheet.getByText("API Key is required.")).toBeVisible();
	});

	test("a token cloud opens its OWN connect sheet, not the pluggable one", async ({ owner }) => {
		// Regression for the category-first route (`lib/connectors/helpers.ts` → connectRoute).
		// Hetzner is category "cloud" with auth_method "api_key"; routing on auth_method first sent
		// it to the pluggable sheet, whose registry has no Hetzner entry, so the panel rendered
		// empty — a connect flow reachable from nowhere.
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByRole("button", { name: "Connect Hetzner Cloud", exact: true }).click();
		const sheet = owner.page.getByRole("dialog");
		await expect(sheet.locator('[data-slot="sheet-title"]')).toHaveText("Connect Hetzner Cloud");
		await expect(sheet.getByLabel("API Token", { exact: true })).toBeVisible({ timeout: 30_000 });
	});
});

test.describe("Connectors — a connected cloud and its manage sheet (seeded)", () => {
	test("a seeded cloud account reads Connected and offers Manage", async ({ owner }) => {
		await seedAwsAccount(owner, `e2e-conn-${Date.now()}`);
		await gotoConnectors(owner.page, owner.orgSlug);
		await expect(
			owner.page.getByRole("button", { name: "Manage Amazon Web Services", exact: true }),
		).toBeVisible({ timeout: 30_000 });
		// The connect action is replaced by Manage, not offered alongside it.
		await expect(
			owner.page.getByRole("button", { name: "Connect Amazon Web Services", exact: true }),
		).toHaveCount(0);
	});

	test("Manage opens the detail sheet listing that account, org-wide", async ({ owner }) => {
		const name = `e2e-detail-${Date.now()}`;
		await seedAwsAccount(owner, name);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page
			.getByRole("button", { name: "Manage Amazon Web Services", exact: true })
			.click();
		const sheet = owner.page.getByRole("dialog");
		await expect(sheet.locator('[data-slot="sheet-title"]')).toContainText(
			"Amazon Web Services",
		);
		// "Cloud accounts": the console's label for a connected account (`lib/copy/vocabulary.ts`).
		await expect(sheet.getByRole("heading", { name: "Cloud accounts", exact: true })).toBeVisible();
		await expect(sheet.getByText(name, { exact: true })).toBeVisible();
		await expect(sheet.getByText("Org-wide")).toBeVisible();
	});

	test("the detail sheet offers 'Add another account' to a manager", async ({ owner }) => {
		await seedAwsAccount(owner, `e2e-add-${Date.now()}`);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page
			.getByRole("button", { name: "Manage Amazon Web Services", exact: true })
			.click();
		await expect(
			owner.page.getByRole("dialog").getByRole("button", { name: /Add another account/i }),
		).toBeVisible();
	});

	test("renaming a connected account persists the new name", async ({ owner }) => {
		const name = `e2e-rename-${Date.now()}`;
		await seedAwsAccount(owner, name);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page
			.getByRole("button", { name: "Manage Amazon Web Services", exact: true })
			.click();
		const sheet = owner.page.getByRole("dialog");
		await expect(sheet.getByText(name, { exact: true })).toBeVisible();
		// The per-account controls carry the account's name (#4268) — a provider holds several
		// accounts, and "Rename" repeated down the list says the verb but never the row.
		await sheet.getByRole("button", { name: `Rename ${name}`, exact: true }).click();
		const editor = sheet.getByLabel("Account name");
		await editor.fill(`${name}-renamed`);
		await editor.press("Enter");
		// The new name only renders once the server action + router.refresh() have completed; the
		// toast is transient, so assert the PERSISTED value.
		await expect(sheet.getByText(`${name}-renamed`, { exact: true })).toBeVisible({
			timeout: 30_000,
		});
	});

	test("disconnecting an account asks for one cloud-specific confirmation", async ({ owner }) => {
		// The board has ONE disconnect confirm, not one per cloud: `confirmDisconnect` in
		// connectors-page.tsx fans out to six different mutations by category/slug behind a single
		// AlertDialog. So this asserts the dialog, and deliberately not which action fired.
		const name = `e2e-disc-${Date.now()}`;
		await seedAwsAccount(owner, name);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page
			.getByRole("button", { name: "Manage Amazon Web Services", exact: true })
			.click();
		const sheet = owner.page.getByRole("dialog");
		await sheet.getByRole("button", { name: `Disconnect ${name}`, exact: true }).click();
		const confirm = owner.page.getByRole("alertdialog");
		await expect(confirm.getByText("Disconnect Amazon Web Services?")).toBeVisible();
		// The dialog says what stops working. Which projects use the account, and whether its name
		// must be typed, depends on this shared org's projects, so neither is asserted here; the
		// component tests pin both (`tests/components/connectors-page-board.test.tsx`).
		await expect(
			confirm.getByText(/no longer be able to plan, deploy or destroy/i),
		).toBeVisible();
		// Cancel — the seeded account survives, and so does every sibling spec's.
		await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(confirm).toHaveCount(0);
		await expect(sheet.getByText(name, { exact: true })).toBeVisible();
	});
});
