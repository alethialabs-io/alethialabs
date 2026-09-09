// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Negative / edge / permission paths for the Connectors board: the honest "not enabled on this
// instance" state for a managed cloud whose platform credentials are absent, the coming-soon
// connector that offers no action at all, client-side validation in the connect sheets, the
// member's read-only board, and the unauthenticated bounce.
//
// Happy paths live in connectors.spec.ts; read its header for the selector rule (every connect /
// manage action is named for the connector it acts on — never `{ name: "Connect" }`).

import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/qa";

// The connectors route runs a heavy server-side setup on every load — allow generous headroom.
test.describe.configure({ timeout: 120_000 });

/** Navigates to the connectors board and waits for the filter bar's search box. */
async function gotoConnectors(page: Page, orgSlug: string): Promise<void> {
	await page.goto(`/${orgSlug}/~/connectors`, { waitUntil: "commit" });
	await expect(page.getByLabel("Search connectors")).toBeVisible({ timeout: 60_000 });
}

test.describe("Connectors — a cloud this instance cannot connect", () => {
	// WHY AZURE, UNCONDITIONALLY. `computePlatformConfigured()` gates aws/gcp/azure/alibaba on the
	// OIDC signing key, which the release-gate job does not set, so all four read "unavailable"
	// WHEN NOT CONNECTED. Azure additionally cannot BE connected in this run: `helpers/seed.ts`
	// writes `credentials: {role_arn}` for every provider, and `identityWasConfigured("azure", …)`
	// demands a subscription or tenant id — so a seeded Azure identity is filtered out of the board
	// as a never-configured placeholder. That is what makes this assertion unconditional rather
	// than the `test.skip(connected > 0, …)` it used to carry: an unset condition that skips is the
	// `HAVE_MEMBER` shape, and the skip was reading a page-wide Manage count that said nothing
	// about Azure anyway.
	test("a managed cloud with no platform credentials says so in words", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByLabel("Search connectors").fill("Microsoft Azure");
		await expect(owner.page.getByText("Not enabled on this instance")).toBeVisible();
	});

	test("…and offers an Unavailable pill instead of a doomed connect", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByLabel("Search connectors").fill("Microsoft Azure");
		await expect(owner.page.getByText("Unavailable", { exact: true }).first()).toBeVisible();
		await expect(
			owner.page.getByRole("button", { name: "Connect Microsoft Azure", exact: true }),
		).toHaveCount(0);
	});

	test("a coming-soon connector offers no action at all", async ({ owner }) => {
		// DigitalOcean has no provisioning templates yet (`status: coming_soon` in the catalog), so
		// the card states that and renders neither Connect nor Manage — connecting it would be a
		// dead end rather than a slow one.
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByLabel("Search connectors").fill("DigitalOcean");
		await expect(owner.page.getByText("Coming soon").first()).toBeVisible();
		await expect(
			owner.page.getByRole("button", { name: "Connect DigitalOcean", exact: true }),
		).toHaveCount(0);
		await expect(
			owner.page.getByRole("button", { name: "Manage DigitalOcean", exact: true }),
		).toHaveCount(0);
	});
});

test.describe("Connectors — connect-sheet validation", () => {
	test("the token-cloud sheet refuses a token that is too short", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByRole("button", { name: "Connect Hetzner Cloud", exact: true }).click();
		const sheet = owner.page.getByRole("dialog");
		const token = sheet.getByLabel("API Token", { exact: true });
		await expect(token).toBeVisible({ timeout: 30_000 });
		await token.fill("too-short");
		await expect(sheet.getByText("Enter a valid Hetzner API token.")).toBeVisible();
	});

	test("the api-key sheet reports the SECOND missing field once the first is filled", async ({
		owner,
	}) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await owner.page.getByRole("button", { name: "Connect Datadog", exact: true }).click();
		const sheet = owner.page.getByRole("dialog");
		// Fill only the API Key; the registry marks the Application Key required too.
		await sheet.getByLabel(/^API Key/).fill("dd-fake-api-key");
		await sheet.getByRole("button", { name: "Connect", exact: true }).click();
		await expect(sheet.getByText("Application Key is required.")).toBeVisible();
	});
});

test.describe("Connectors — member permissions (read-only)", () => {
	// READ `flows/_persona-integrity.spec.ts` BEFORE TRUSTING A RESULT HERE. A member with no
	// access at all renders the org 404 on every route, and an absence assertion then passes while
	// measuring nothing. So the denial below is COMPARATIVE — the owner of the SAME org is asked
	// for the same thing in the same test — and it is preceded by a test proving the member's board
	// actually rendered.
	test("the member's board renders (it is a permission denial, not an org 404)", async ({
		member,
	}) => {
		await gotoConnectors(member.page, member.orgSlug);
		await expect(member.page).not.toHaveURL(/\/login/);
		await expect(member.page.getByRole("heading", { name: "Clouds", exact: true })).toBeVisible();
		await expect(member.page.getByText("Datadog").first()).toBeVisible();
	});

	test("a member without manage rights sees no connect action the owner does see", async ({
		member,
		team,
	}) => {
		// `member` is an invited member of `team`'s org, so both sessions read the same board.
		await gotoConnectors(team.page, team.orgSlug);
		await expect(
			team.page.getByRole("button", { name: "Connect Datadog", exact: true }),
		).toBeVisible();

		await gotoConnectors(member.page, member.orgSlug);
		await expect(
			member.page.getByRole("button", { name: "Connect Datadog", exact: true }),
		).toHaveCount(0);
	});
});

// NO unauthenticated-bounce test here on purpose: `flows/cross-cutting.negative.spec.ts` already
// drives an anonymous visitor at `/{org}/~/connectors` and asserts both the /login redirect and
// that the authed shell did not leak. A second copy would double the cost of the same measurement
// and give two places to update when the gate moves.
