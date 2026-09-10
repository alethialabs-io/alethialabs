// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub — the gated and refused paths: the plan gate on a community (Hobby) org, the
// reduced-permission member, and the fail-closed transport. The happy-path CRUD is in
// alerts.spec.ts.
//
// NOTHING HERE SEEDS OR CLEANS ALERT ROWS. alerts.spec.ts owns the team org's alerting tables
// and wipes them between its own describes; these specs run in a different worker at the same
// time, so any assertion here that depended on a seeded channel would be racing that wipe.
// Every assertion below therefore holds for an empty universe and a populated one alike.

import { test, expect } from "../fixtures/qa";

const ALERTS = (org: string) => `/${org}/~/alerts`;

test.describe("Alerts — the plan gate (community org)", () => {
	test("a Hobby org gets the upsell instead of the surface", async ({ owner }) => {
		await owner.page.goto(ALERTS(owner.orgSlug!));
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(
			owner.page.getByRole("heading", { name: "Alerts & notifications" }),
		).toBeVisible({ timeout: 15_000 });
		await expect(owner.page.getByText("Available on the Pro plan.")).toBeVisible();
	});

	// `FeatureUpsell` is composed from `@repo/ui/empty` — a locked feature and an empty list are
	// the same shape of "nothing here", and the panel passes `level={3}` so its title stays in the
	// outline rather than becoming EmptyState's default `<div>`.
	test("the upsell is an EmptyState, and its title is a real heading", async ({
		owner,
	}) => {
		await owner.page.goto(ALERTS(owner.orgSlug!));
		const heading = owner.page.getByRole("heading", {
			name: "Alerts & notifications",
			level: 3,
		});
		await expect(heading).toBeVisible({ timeout: 15_000 });
		// The heading is INSIDE the shared empty-state shell — asserted as containment rather than
		// as two separate visibilities, so a page that happened to carry another `Empty` somewhere
		// could not satisfy it by accident.
		await expect(
			owner.page.locator("[data-slot='empty']").filter({ has: heading }),
		).toHaveCount(1);
	});

	test("the upsell exposes no channel or policy management controls", async ({
		owner,
	}) => {
		await owner.page.goto(ALERTS(owner.orgSlug!));
		await expect(
			owner.page.getByRole("heading", { name: "Alerts & notifications" }),
		).toBeVisible({ timeout: 15_000 });
		await expect(
			owner.page.getByRole("button", { name: "Add channel" }),
		).toHaveCount(0);
		await expect(
			owner.page.getByRole("button", { name: "New policy" }),
		).toHaveCount(0);
	});

	test("a Hobby org never reaches the three section headings", async ({ owner }) => {
		await owner.page.goto(ALERTS(owner.orgSlug!));
		await expect(
			owner.page.getByRole("heading", { name: "Alerts & notifications" }),
		).toBeVisible({ timeout: 15_000 });
		for (const name of ["Policies", "Channels", "Activity"]) {
			await expect(
				owner.page.getByRole("heading", { name, exact: true }),
			).toHaveCount(0);
		}
	});
});

test.describe("Alerts — a reduced-permission member", () => {
	// The positive control the persona-integrity rule requires: a member with no access at all
	// renders the org 404 everywhere, and a 404 satisfies every "the control is absent" assertion
	// for the wrong reason. So the denial is only meaningful next to something the member DOES
	// see — here, the same three section headings the owner of this org sees.
	test("sees the alerting surface, since the org's plan unlocks it", async ({
		member,
	}) => {
		await member.page.goto(ALERTS(member.orgSlug!));
		await expect(member.page).not.toHaveURL(/\/login/);
		for (const name of ["Policies", "Channels", "Activity"]) {
			await expect(
				member.page.getByRole("heading", { name, exact: true }),
			).toBeVisible({ timeout: 15_000 });
		}
	});

	test("cannot add a channel or create a policy", async ({ member }) => {
		await member.page.goto(ALERTS(member.orgSlug!));
		await expect(
			member.page.getByRole("heading", { name: "Channels", exact: true }),
		).toBeVisible({ timeout: 15_000 });
		await expect(
			member.page.getByRole("button", { name: "Add channel" }),
		).toHaveCount(0);
		await expect(
			member.page.getByRole("button", { name: "New policy" }),
		).toHaveCount(0);
	});
});

test.describe("Alerts — a transport that cannot store its secret", () => {
	// FAIL-CLOSED, AND THIS IS A MEASUREMENT OF THE LEG'S CONFIGURATION AS MUCH AS OF THE UI.
	// Every transport but Email keeps a credential, which needs ALETHIA_CRED_ENCRYPTION_KEY. The
	// `qa` leg does not promise the `encryption` capability, so the key is unset for it and the
	// console correctly refuses to take a credential: the sheet explains what is missing and the
	// submit is disabled. That is why no spec in this domain creates a Slack or webhook channel —
	// it is not an omission, it is the only behaviour reachable here.
	//
	// ⚠ SAY "THIS LEG", NOT "THE GATE". Since #4456 release-gate.yml DOES set the key — on the
	// `console` and `audit-interaction` legs, which promise `encryption` — and the capability is
	// one a leg may promise (helpers/capabilities.ts). What is true here is a fact about the `qa`
	// row of the leg table, and it stops being true the moment that row promises `encryption`.
	//
	// WHEN IT DOES, only the FIRST of the two below goes red — and the second is the one to watch.
	// "an Email channel is still offered, because it stores no secret" is a CONTRAST with its
	// sibling: it stays green with the key present, having stopped measuring anything, and nothing
	// would say so. Both are therefore rewritten into the positive paths they stand in for (the
	// submit is live and the note is absent; the webhook verification failure reaches the user,
	// which is only reachable once the secret can be stored), tagged `@needs:encryption` so a leg
	// that stops promising it makes them RED rather than quietly skipped. That rewrite RENAMES
	// them, and a renamed test is a baseline entry the run no longer contains —
	// `scripts/e2e-ratchet.mjs` rule 4 — so it lands with the matching edit to
	// `apps/console/e2e/gate-baseline.json`, which is the whole of what `qa` is waiting on.
	test("a secret-bearing transport explains the missing key and disables the submit", async ({
		team,
	}) => {
		await team.page.goto(ALERTS(team.orgSlug!));
		await expect(team.page).not.toHaveURL(/\/login/);
		await expect(
			team.page.getByRole("heading", { name: "Channels", exact: true }),
		).toBeVisible({ timeout: 15_000 });

		await team.page
			.locator("#channels")
			.getByRole("button", { name: "Add channel" })
			.first()
			.click();
		const sheet = team.page.getByRole("dialog", { name: "Add a channel" });
		await expect(sheet).toBeVisible();

		// Slack is the sheet's default transport, and it stores a URL.
		await sheet.getByRole("button", { name: "Webhook HTTPS POST" }).click();
		await expect(
			sheet.getByText(/This transport stores a secret, which needs an encryption key/),
		).toBeVisible();
		await expect(sheet.getByRole("button", { name: "Add channel" })).toBeDisabled();
	});

	test("an Email channel is still offered, because it stores no secret", async ({
		team,
	}) => {
		await team.page.goto(ALERTS(team.orgSlug!));
		await expect(
			team.page.getByRole("heading", { name: "Channels", exact: true }),
		).toBeVisible({ timeout: 15_000 });
		await team.page
			.locator("#channels")
			.getByRole("button", { name: "Add channel" })
			.first()
			.click();
		const sheet = team.page.getByRole("dialog", { name: "Add a channel" });
		await sheet.getByRole("button", { name: "Email SES relay" }).click();
		await expect(sheet.getByRole("button", { name: "Add channel" })).toBeEnabled();
		await expect(
			sheet.getByText(/This transport stores a secret, which needs an encryption key/),
		).toHaveCount(0);
	});
});
