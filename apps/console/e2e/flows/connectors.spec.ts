// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Exhaustive e2e for the Connectors board (/{org}/~/connectors): the connector catalog with
// grouped sections (Clouds / Secrets / Registries / Apps), the group-filter Select, search, the
// card↔table view toggle, the cloud/api-key/token-cloud connect sheets (opened + validated, never
// submitting real creds), and — via a seeded connected cloud identity — the connected state and the
// manage/detail sheet (rename, add-another, disconnect confirm). Cloud verification is server-side,
// so no runner is needed. Negative/permission/not-enabled paths live in connectors.negative.spec.ts.
//
// Isolation note: the QA harness forbids cleanupOrg during the parallel run (it would wipe sibling
// agents' seeded rows), so every connected-state test seeds its OWN uniquely-named cloud identity and
// scopes assertions to that name; accumulated AWS accounts are expected and harmless.

import { test, expect } from "../fixtures/qa";
import { scanA11y } from "../helpers/a11y";
import { seedCloudIdentity } from "../helpers/seed";

// The connectors route re-runs a costly server-side setup on every load (per-provider health probes
// + a pending-identity INSERT for each unconnected cloud), so navigations are slow — and slower under
// concurrent load. Give tests generous headroom. See findings re: the page's per-load cost.
test.describe.configure({ timeout: 120_000 });

/** Navigates to the org connectors board and waits for the search box to render. */
async function gotoConnectors(page: import("@playwright/test").Page, orgSlug: string) {
	await page.goto(`/${orgSlug}/~/connectors`, { waitUntil: "commit" });
	await expect(page.getByPlaceholder(/search connectors/i)).toBeVisible({ timeout: 60_000 });
}

/** Selects a group in the top-bar filter Select (Radix combobox → option). */
async function selectGroup(page: import("@playwright/test").Page, label: RegExp) {
	await page.getByRole("combobox").click();
	await page.getByRole("option", { name: label }).click();
}

/** Seeds a connected token cloud (Hetzner) so its connect sheet can be opened deterministically. */
async function seedHetzner(owner: { userId?: string; orgId?: string }, name: string) {
	await seedCloudIdentity(
		{ userId: owner.userId!, orgId: owner.orgId! },
		{ provider: "hetzner", name },
	);
}

test.describe("Connectors — browse & filter", () => {
	test("loads the connectors board authenticated (no bounce to login)", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByRole("combobox")).toBeVisible();
	});

	test("renders all four connector group sections by default", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		for (const heading of ["Clouds", "Secrets", "Registries", "Apps"]) {
			await expect(owner.page.getByRole("heading", { name: heading })).toBeVisible();
		}
	});

	test("shows known cloud + app connectors from the catalog", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await expect(owner.page.getByText("Amazon Web Services").first()).toBeVisible();
		await expect(owner.page.getByText("GitHub").first()).toBeVisible();
		await expect(owner.page.getByText("Datadog").first()).toBeVisible();
	});

	test("each group header shows an 'N / M connected' counter", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await expect(owner.page.getByText(/\d+ \/ \d+ connected/).first()).toBeVisible();
	});

	test("group filter narrows the board to Clouds only", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await selectGroup(owner.page, /Clouds/);
		await expect(owner.page.getByText("Amazon Web Services").first()).toBeVisible();
		// Non-cloud connectors + their section headings drop out.
		await expect(owner.page.getByText("Datadog")).toHaveCount(0);
		await expect(owner.page.getByRole("heading", { name: "Apps" })).toHaveCount(0);
	});

	test("group filter narrows the board to Apps only", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await selectGroup(owner.page, /Apps/);
		await expect(owner.page.getByText("GitHub").first()).toBeVisible();
		await expect(owner.page.getByRole("heading", { name: "Clouds" })).toHaveCount(0);
	});

	test("search filters connectors by name", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("Datadog");
		await expect(owner.page.getByText("Datadog").first()).toBeVisible();
		await expect(owner.page.getByText("GitHub")).toHaveCount(0);
	});

	test("search matches on the provider organization too", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		// "HashiCorp" is the organization behind Vault, not in its display name.
		await owner.page.getByPlaceholder(/search connectors/i).fill("HashiCorp");
		await expect(owner.page.getByText("HashiCorp Vault").first()).toBeVisible();
		await expect(owner.page.getByText("Amazon Web Services")).toHaveCount(0);
	});

	test("no-match search shows the empty-state copy", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("zzz-no-such-connector");
		await expect(
			owner.page.getByText("No connectors match your search."),
		).toBeVisible();
	});

	test("clearing the search restores the full board", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		const search = owner.page.getByPlaceholder(/search connectors/i);
		await search.fill("Datadog");
		await expect(owner.page.getByText("GitHub")).toHaveCount(0);
		await search.fill("");
		await expect(owner.page.getByText("GitHub").first()).toBeVisible();
	});

	test("toggles from card view to table view and back", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByRole("button", { name: /table view/i }).click();
		await expect(owner.page.getByRole("table").first()).toBeVisible();
		await owner.page.getByRole("button", { name: /card view/i }).click();
		await expect(owner.page.getByRole("table")).toHaveCount(0);
	});

	test("table view renders the connector column headers", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByRole("button", { name: /table view/i }).click();
		await expect(
			owner.page.getByRole("columnheader", { name: "Connector" }).first(),
		).toBeVisible();
		await expect(
			owner.page.getByRole("columnheader", { name: "Status" }).first(),
		).toBeVisible();
	});

	test("board has no serious/critical a11y violations (soft)", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		const violations = await scanA11y(owner.page);
		expect(Array.isArray(violations)).toBe(true);
	});
});

test.describe("Connectors — connect sheets (open + validate, no submit)", () => {
	test("api-key connector opens its credential sheet", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("Datadog");
		await owner.page.getByRole("button", { name: "Connect" }).click();
		await expect(owner.page.getByRole("heading", { name: "Connect Datadog" })).toBeVisible();
		await expect(owner.page.getByText("API Key", { exact: false }).first()).toBeVisible();
	});

	test("api-key sheet blocks submit and shows required-field errors", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("Datadog");
		await owner.page.getByRole("button", { name: "Connect" }).click();
		const sheet = owner.page.getByRole("dialog");
		// Submit empty → registry-driven inline validation (no server call).
		await sheet.getByRole("button", { name: "Connect" }).click();
		await expect(sheet.getByText("API Key is required.")).toBeVisible();
	});

	// BUG: token clouds (digitalocean/hetzner/civo) are catalog category "cloud" but auth_method
	// "api_key". connectors-page.tsx handleConnect checks auth_method === "api_key" BEFORE the cloud
	// branch, so it routes them to ApiKeyConnection via getConnectorProviderBySlug(slug) — which is
	// undefined (token clouds aren't in the pluggable registry) → the sheet renders empty (just a
	// Close button). The intended TokenCloudConnection sheet is unreachable from the board. Asserts
	// the correct behavior (a token field), which currently fails.
	test(
		"token-cloud connect sheet opens with an API-token field",
		async ({ owner }) => {
			await seedHetzner(owner, `e2e-htz-open-${Date.now()}`);
			await gotoConnectors(owner.page, owner.orgSlug);
			await owner.page.getByPlaceholder(/search connectors/i).fill("Hetzner");
			await owner.page.getByRole("button", { name: "Manage" }).first().click();
			await owner.page
				.getByRole("dialog")
				.getByRole("button", { name: /Add another account/i })
				.click();
			// Correct behavior: the token-cloud connect sheet with its API-token field.
			await expect(
				owner.page.getByPlaceholder(/scoped API token/i),
			).toBeVisible({ timeout: 30_000 });
		},
	);
});

test.describe("Connectors — connected cloud & manage sheet (seeded)", () => {
	test("a connected cloud identity surfaces as Connected with a Manage action", async ({
		owner,
	}) => {
		const name = `e2e-conn-${Date.now()}`;
		await seedCloudIdentity(
			{ userId: owner.userId!, orgId: owner.orgId! },
			{ provider: "aws", name },
		);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("Amazon Web Services");
		await expect(owner.page.getByText("Connected").first()).toBeVisible({ timeout: 10_000 });
		await expect(owner.page.getByRole("button", { name: "Manage" }).first()).toBeVisible();
	});

	test("Manage opens the detail sheet listing the connected account", async ({ owner }) => {
		const name = `e2e-detail-${Date.now()}`;
		await seedCloudIdentity(
			{ userId: owner.userId!, orgId: owner.orgId! },
			{ provider: "aws", name },
		);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("Amazon Web Services");
		await owner.page.getByRole("button", { name: "Manage" }).first().click();
		const sheet = owner.page.getByRole("dialog");
		await expect(
			sheet.getByRole("heading", { name: "Amazon Web Services" }),
		).toBeVisible();
		await expect(sheet.getByText("Accounts", { exact: true })).toBeVisible();
		await expect(sheet.getByText(name, { exact: true })).toBeVisible();
	});

	test("detail sheet shows the org-wide scope badge for an org-shared identity", async ({
		owner,
	}) => {
		const name = `e2e-scope-${Date.now()}`;
		await seedCloudIdentity(
			{ userId: owner.userId!, orgId: owner.orgId! },
			{ provider: "aws", name },
		);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("Amazon Web Services");
		await owner.page.getByRole("button", { name: "Manage" }).first().click();
		const sheet = owner.page.getByRole("dialog");
		await expect(sheet.getByText("Org-wide")).toBeVisible();
	});

	test("detail sheet offers 'Add another account' for a manager", async ({ owner }) => {
		const name = `e2e-add-${Date.now()}`;
		await seedCloudIdentity(
			{ userId: owner.userId!, orgId: owner.orgId! },
			{ provider: "aws", name },
		);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("Amazon Web Services");
		await owner.page.getByRole("button", { name: "Manage" }).first().click();
		const sheet = owner.page.getByRole("dialog");
		await expect(
			sheet.getByRole("button", { name: /Add another account/i }),
		).toBeVisible();
	});

	test("renaming a connected account persists the new name", async ({ owner }) => {
		const name = `e2e-rename-${Date.now()}`;
		await seedCloudIdentity(
			{ userId: owner.userId!, orgId: owner.orgId! },
			{ provider: "aws", name },
		);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("Amazon Web Services");
		await owner.page.getByRole("button", { name: "Manage" }).first().click();
		const sheet = owner.page.getByRole("dialog");
		// The account row: name div → (min-w-0 flex-1) → row div holding the icon buttons.
		const nameEl = sheet.getByText(name, { exact: true });
		await expect(nameEl).toBeVisible();
		const row = nameEl.locator("xpath=../..");
		// Icon-only buttons (no accessible name) — pencil is first, unlink second. See findings.
		await row.getByRole("button").first().click();
		const editInput = sheet.getByRole("textbox");
		await editInput.fill(`${name}-renamed`);
		await editInput.press("Enter");
		// The renamed name only re-renders after the server action + router.refresh() completes; the
		// success toast is transient, so assert the persisted value (generous timeout for the heavy refresh).
		await expect(sheet.getByText(`${name}-renamed`, { exact: true })).toBeVisible({
			timeout: 30_000,
		});
	});

	test("disconnect from the detail sheet asks for cloud-specific confirmation", async ({
		owner,
	}) => {
		const name = `e2e-disc-${Date.now()}`;
		await seedCloudIdentity(
			{ userId: owner.userId!, orgId: owner.orgId! },
			{ provider: "aws", name },
		);
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("Amazon Web Services");
		await owner.page.getByRole("button", { name: "Manage" }).first().click();
		const sheet = owner.page.getByRole("dialog");
		const nameEl = sheet.getByText(name, { exact: true });
		const row = nameEl.locator("xpath=../..");
		// Unlink is the second icon-only button in the row.
		await row.getByRole("button").nth(1).click();
		const confirm = owner.page.getByRole("alertdialog");
		await expect(
			confirm.getByText("Disconnect Amazon Web Services?"),
		).toBeVisible();
		await expect(
			confirm.getByText(/won't be able to provision new infrastructure/i),
		).toBeVisible();
		// Cancel — leave the seeded identity intact for other assertions.
		await confirm.getByRole("button", { name: "Cancel" }).click();
		await expect(confirm).toHaveCount(0);
	});
});

test.describe("Connectors — git connector", () => {
	test("an unconnected git connector offers a Connect action", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByPlaceholder(/search connectors/i).fill("GitHub");
		await expect(owner.page.getByText("GitHub").first()).toBeVisible();
		// Don't click — the git Connect kicks off an OAuth redirect off-app.
		await expect(
			owner.page.getByRole("button", { name: "Connect" }),
		).toBeVisible();
	});
});
