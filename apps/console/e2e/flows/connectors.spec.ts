// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Exhaustive e2e for the Connectors board (`/{org}/~/connectors`) as it is TODAY: the console
// filter standard (search → chips → Group facet → vendor combobox → reset, URL-synced, facet
// counts over the unfiltered universe), the seven catalog sections, the card↔table toggle, the
// per-cloud connect sheets (opened + validated, never submitting real credentials) and — via a
// seeded cloud identity — the connected state, the manage sheet and the disconnect confirm.
// Negative / permission / not-enabled paths live in connectors.negative.spec.ts.
//
// WHAT THE JULY SPEC LOOKED FOR AND WHY IT IS GONE. It drove a Radix `<Select>` group filter
// (`getByRole("combobox")`), four sections named Clouds / Secrets / Registries / **Apps**, an
// `N / M connected` counter and the copy "No connectors match your search." None of those exist:
// the bar moved to the shared filter grammar (`components/connectors/connectors-filter-bar.tsx`),
// `apps` was split into source / registries / chart_repos / observability / dns
// (`connectors-query.ts` → `GROUP_META`), the header counter reads "N connected", and the empty
// state is an `EmptyState` titled "No connectors match".
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
 * waits for the filter bar's search box, which is the board's first interactive element.
 */
async function gotoConnectors(page: Page, orgSlug: string, query = ""): Promise<void> {
	await page.goto(`/${orgSlug}/~/connectors${query}`, { waitUntil: "commit" });
	await expect(page.getByLabel("Search connectors")).toBeVisible({ timeout: 60_000 });
}

/** The board's free-text filter input (accessible name, not placeholder — see the filter bar). */
const search = (page: Page) => page.getByLabel("Search connectors");

/**
 * Opens the Group facet popover. The trigger's accessible name grows a selection badge
 * ("Group" → "Group 1"), so it is matched by prefix rather than exactly.
 */
async function openGroupFacet(page: Page): Promise<void> {
	await page.getByRole("button", { name: /^Group\b/ }).click();
	await expect(page.getByRole("option", { name: /^Clouds/ })).toBeVisible();
}

/** A group section's `<h2>` — `SectionHeading` renders the label, the count rides beside it. */
const groupHeading = (page: Page, label: string) =>
	page.getByRole("heading", { name: label, exact: true });

/** Seeds a connected AWS account (the one provider `helpers/seed.ts` writes real credentials for). */
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
		// The four controls the console filter standard requires of a list page's bar.
		await expect(search(owner.page)).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /^Group\b/ })).toBeVisible();
		await expect(owner.page.getByPlaceholder("All vendors")).toBeVisible();
		await expect(owner.page.getByRole("button", { name: "Table view" })).toBeVisible();
	});

	test("the page toolbar carries the result count, and the page carries no title", async ({
		owner,
	}) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		const pill = owner.page.locator('[data-slot="page-toolbar"] [data-slot="count-pill"]');
		await expect(pill).toHaveText(/^\d+$/);
		expect(Number(await pill.innerText())).toBeGreaterThan(20);
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
		await expect(owner.page.getByText("No connectors match")).toBeVisible();
		// The description states the size of the universe the filters were applied to.
		await expect(owner.page.getByText(/None of the \d+ connectors in the catalog/)).toBeVisible();
		await expect(owner.page.getByRole("button", { name: "Reset filters" })).toBeVisible();
	});

	test("Reset filters from the empty state restores the whole board", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await search(owner.page).fill("zzz-no-such-connector");
		await owner.page.getByRole("button", { name: "Reset filters" }).click();
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
		await expect(owner.page.getByRole("button", { name: /^Group\b/ })).toContainText("1");
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
		const before = await owner.page.getByRole("option", { name: /^Registries/ }).textContent();
		await owner.page.getByRole("option", { name: /^Clouds/ }).click();
		await owner.page.keyboard.press("Escape");
		// The board now shows Clouds only — and the Registries option must still be offered, with
		// the same count it had over the unfiltered catalog.
		await expect(groupHeading(owner.page, "Registries")).toHaveCount(0);
		await openGroupFacet(owner.page);
		await expect(owner.page.getByRole("option", { name: /^Registries/ })).toHaveText(
			before ?? "",
		);
	});

	test("the Status chips filter the board by health bucket", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		// The chip's accessible name is its label plus its facet count ("Coming soon 11").
		await owner.page.getByRole("button", { name: /^Coming soon\b/ }).click();
		// Every remaining row is coming-soon, so nothing on the board offers a connect action.
		await expect(owner.page.getByRole("button", { name: /^Connect / })).toHaveCount(0);
		await expect(owner.page.getByText("DigitalOcean").first()).toBeVisible();
	});

	test("the vendor combobox narrows the board to one organization", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder("All vendors").click();
		await owner.page.getByRole("button", { name: /^Datadog, Inc\./ }).click();
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
		await expect(sheet.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();
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
		await expect(
			confirm.getByText(/won't be able to provision new infrastructure/i),
		).toBeVisible();
		// Cancel — the seeded account survives, and so does every sibling spec's.
		await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(confirm).toHaveCount(0);
		await expect(sheet.getByText(name, { exact: true })).toBeVisible();
	});
});
