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

/**
 * Types a search term and waits for the board to actually be filtered by it.
 *
 * FILLING THE BOX IS NOT FILTERING THE BOARD. Free text goes through `useDebouncedValue` (250ms)
 * before it reaches the query key, so an assertion fired straight after `fill()` reads the
 * UNFILTERED board — which is how this file's first version failed: `getByText("Not enabled on
 * this instance")` resolved to seven elements, one per unavailable connector in the whole
 * catalog (aws · gcp · azure · alibaba · github · gitlab · bitbucket), and the Azure card was
 * only one of them.
 *
 * The settle point is the toolbar's count pill, which IS the row count, so this states how many
 * connectors the term is expected to match. `toHaveText` retries, so it waits out the debounce —
 * and a catalog change that moves the number reds here, naming it, instead of silently making a
 * sibling assertion true about the wrong card. That is the reason this is not a `.first()`.
 */
async function filterTo(page: Page, term: string, rows: number): Promise<void> {
	await page.getByLabel("Search connectors").fill(term);
	await expect(
		page.locator('[data-slot="page-toolbar"] [data-slot="count-pill"]'),
	).toHaveText(String(rows));
}

test.describe("Connectors — a cloud this instance cannot connect", () => {
	// THE SUBJECT IS `connectorState()`'s `unavailable` BRANCH, whose condition is
	// `!platformConfigured && !connected`. `computePlatformConfigured()` gates aws/gcp/azure/alibaba
	// on the OIDC signing key, which the release-gate job does not set, so the FIRST half holds for
	// all four clouds in this run. Azure is the one picked because its catalog neighbours make the
	// row count below unambiguous.
	//
	// THE SECOND HALF IS A PROPERTY OF THIS ORG, NOT OF THE CATALOG, so this spec proves it instead
	// of assuming it — see `expectNoConnectedAccount`. The persona org is shared with every other QA
	// worker, they seed cloud identities into it, and nothing cleans up; "Azure is not connected
	// here" is therefore a precondition, and an unstated precondition is how a test starts passing
	// for a reason it never claimed.
	//
	// It USED to be justified by a defect (#4708): `helpers/seed.ts` wrote `{role_arn}` for every
	// provider, so a seeded Azure identity was filtered out by `identityWasConfigured` as a
	// never-configured placeholder, and the comment here reasoned from that. Two things were wrong
	// with it. It was never load-bearing — nothing in this suite seeds Azure at all, so the filter
	// it named had nothing to filter — and it recorded a BUG as the reason a test was sound, which
	// is the shape that makes fixing the bug look like breaking the test. The seeder now writes a
	// provider-shaped credential, and this describe depends on nothing it does.
	//
	// "Microsoft Azure" matches three catalog rows — the cloud itself by name, and the ACR and Key
	// Vault cross-account connectors by vendor. Only the cloud is `active`; the other two are
	// coming-soon, so exactly one row can carry the unavailable wording.
	const AZURE_MATCHES = 3;
	const AZURE = "Microsoft Azure";

	/**
	 * Proves the half of the subject that is about THIS ORG rather than this instance: no account is
	 * connected for the connector.
	 *
	 * `Manage <name>` is the affordance `ConnectorCard` renders for a connected connector and for no
	 * other state — and the `unavailable` branch it would have to displace is checked BEFORE it in
	 * that card, so a connected Azure would show Manage and no Unavailable pill. Asserting its
	 * absence here means a future spec that seeds an Azure identity reds THIS line, which names what
	 * changed, rather than the status-wording count below, which would read as a catalog regression.
	 */
	async function expectNoConnectedAccount(page: Page, connector: string): Promise<void> {
		await expect(
			page.getByRole("button", { name: `Manage ${connector}`, exact: true }),
		).toHaveCount(0);
	}

	test("a managed cloud with no platform credentials says so in words", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await filterTo(owner.page, AZURE, AZURE_MATCHES);
		await expectNoConnectedAccount(owner.page, AZURE);
		// `exact` throughout this describe: `getByText` defaults to a CASE-INSENSITIVE SUBSTRING
		// match, which on this board reaches two things that are not a card's status — the health
		// filter chip, whose text is the label plus its facet count, and a connector's own
		// description. The claim is about the status wording, so match the status wording.
		await expect(
			owner.page.getByText("Not enabled on this instance", { exact: true }),
		).toHaveCount(1);
	});

	test("…and offers an Unavailable pill instead of a doomed connect", async ({ owner }) => {
		await gotoConnectors(owner.page, owner.orgSlug);
		await filterTo(owner.page, AZURE, AZURE_MATCHES);
		await expectNoConnectedAccount(owner.page, AZURE);
		await expect(owner.page.getByText("Unavailable", { exact: true })).toHaveCount(1);
		await expect(
			owner.page.getByRole("button", { name: `Connect ${AZURE}`, exact: true }),
		).toHaveCount(0);
	});

	test("a coming-soon connector offers no action at all", async ({ owner }) => {
		// DigitalOcean has no provisioning templates yet (`status: coming_soon` in the catalog), so
		// the card states that and renders neither Connect nor Manage — connecting it would be a
		// dead end rather than a slow one. Two rows match: the cloud, and its container registry
		// (which IS connectable — that is the pair that makes the exact button names below load-bearing).
		await gotoConnectors(owner.page, owner.orgSlug);
		await filterTo(owner.page, "DigitalOcean", 2);
		// `exact` is load-bearing here and was measured: without it this resolved to THREE
		// elements on a two-row board — the card's status, the "Coming soon" filter chip (whose
		// text is "Coming soon <count>"), and DigitalOcean's own description, which ends
		// "Provisioning templates coming soon." on a case-insensitive substring match.
		await expect(owner.page.getByText("Coming soon", { exact: true })).toHaveCount(1);
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
