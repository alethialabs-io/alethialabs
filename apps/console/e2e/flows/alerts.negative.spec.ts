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
import type { Page } from "@playwright/test";

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

test.describe("Alerts — a secret-bearing transport, now that the leg promises a key", () => {
	// WHAT THIS BLOCK USED TO BE, AND WHY BOTH HALVES HAD TO GO.
	//
	// Every transport but Email keeps a credential, which needs ALETHIA_CRED_ENCRYPTION_KEY. No gate
	// leg set one, so the console correctly refused to take a credential and the two tests here
	// asserted that refusal — the sheet's "needs an encryption key" note and its disabled submit —
	// under a comment reading "If the gate ever promises the key, THIS is the test that goes red and
	// says so". The `qa` leg now promises `encryption` (#4456), so it has.
	//
	// ⚠ ONLY ONE OF THE TWO WENT RED, and the other is the reason this rewrite is not a one-line
	// fix. "an Email channel is still offered, because it stores no secret" asserted an ENABLED
	// submit and an ABSENT note for a transport that never needed the key — both still true with the
	// key present. It would have stayed GREEN while measuring nothing at all: its whole meaning was
	// the CONTRAST with its sibling, and the sibling was gone. A test that goes red says so; a test
	// that quietly stops discriminating is the shape this suite's capability mechanism exists to
	// end, and nothing in the gate would have reported it.
	//
	// So both are replaced by the paths they were standing in for, which are reachable for the first
	// time: the submit is LIVE for a transport that stores a secret, and a webhook whose endpoint
	// cannot be verified reports that failure to the user.
	//
	// `@needs:encryption` on both: on a leg that stops promising it these are RED, never a green
	// skip (helpers/capabilities.ts). That is the whole point of the tag — the previous version of
	// this block was the "write a test that quietly asserts the disabled state" option the module's
	// header names as the thing it exists to prevent.
	//
	// STILL SEEDS AND CLEANS NOTHING, per this file's header: verification runs BEFORE the insert
	// (app/server/actions/alerts.ts — "a channel never exists unverified"), so the failing path
	// below writes no row, and the passing assertions read the sheet rather than the rail.

	/** Opens the Channels add-a-channel sheet and returns it. */
	async function openSheet(page: Page, org: string) {
		await page.goto(ALERTS(org));
		await expect(page).not.toHaveURL(/\/login/);
		await expect(
			page.getByRole("heading", { name: "Channels", exact: true }),
		).toBeVisible({ timeout: 15_000 });
		await page
			.locator("#channels")
			.getByRole("button", { name: "Add channel" })
			.first()
			.click();
		const sheet = page.getByRole("dialog", { name: "Add a channel" });
		await expect(sheet).toBeVisible();
		return sheet;
	}

	// BOTH url-credential transports, not one. Slack is the sheet's default and Webhook is the one
	// with the extra signing-secret field, and `needsKey` is computed per transport
	// (channel-sheet.tsx: `meta.credential !== "email" && !encryptionConfigured`) — so asserting a
	// single transport would leave "the key reached the product" true of one shape and untested for
	// the other.
	//
	// ⚠ EACH TRANSPORT IS ANCHORED TO ITS OWN URL FIELD BEFORE THE ABSENCE IS ASSERTED, and that
	// ordering is the test. The note is absent for the whole run once the key is set, so
	// `toHaveCount(0)` is satisfied the instant it is asked — including on a click that did nothing
	// at all. A missing-note assertion that cannot tell "this transport is selected and clean" from
	// "the gallery never switched" is asserting about the wrong thing. Waiting for the field this
	// transport and no other renders (`channel-sheet.tsx`: "Payload URL" for webhook,
	// `${name} webhook URL` for the rest) is what makes the absence mean something.
	test(
		"a secret-bearing transport carries no missing-key note, and its submit is live",
		{ tag: "@needs:encryption" },
		async ({ team }) => {
			const sheet = await openSheet(team.page, team.orgSlug!);
			const transports = [
				{ gallery: "Slack Incoming webhook", urlField: "Slack webhook URL" },
				{ gallery: "Webhook HTTPS POST", urlField: "Payload URL" },
			];
			for (const { gallery, urlField } of transports) {
				await sheet.getByRole("button", { name: gallery }).click();
				await expect(
					sheet.getByLabel(urlField, { exact: true }),
				).toBeVisible({ timeout: 10_000 });
				await expect(
					sheet.getByText(/This transport stores a secret, which needs an encryption key/),
				).toHaveCount(0);
				await expect(
					sheet.getByRole("button", { name: "Add channel" }),
				).toBeEnabled();
			}
		},
	);

	// THE PATH THE MISSING KEY MADE UNREACHABLE. `addChannel` encrypts the secret and only THEN
	// verifies the endpoint, so an error that names the endpoint proves the encryption step ran.
	//
	// 198.51.100.9 is TEST-NET-2 (RFC 5737, reserved for documentation and guaranteed unroutable).
	// lib/net/ssrf-guard.ts refuses it at CLASSIFICATION — `dns.lookup` short-circuits an IP
	// literal, so this test opens no socket, waits on no resolver and cannot flake on either.
	//
	// ⚠ THE ASSERTION NAMES THE ADDRESS, and that is not decoration. TWO other failures reach this
	// same rendering: the missing-key error, and the rate limiter's "Too many attempts". Both would
	// satisfy a bare "an error appeared" — the first of them VACUOUSLY, since it is exactly the
	// state this test exists to prove is over. Only the real path can echo back what was typed.
	test(
		"a webhook whose endpoint cannot be verified reports it, and creates nothing",
		{ tag: "@needs:encryption" },
		async ({ team }) => {
			const sheet = await openSheet(team.page, team.orgSlug!);
			await sheet.getByRole("button", { name: "Webhook HTTPS POST" }).click();
			await sheet.getByLabel("Name", { exact: true }).fill(`e2e-unreachable-${Date.now()}`);
			await sheet
				.getByLabel("Payload URL", { exact: true })
				.fill("https://198.51.100.9/e2e-alerts-webhook");
			await sheet.getByRole("button", { name: "Add channel" }).click();

			await expect(
				sheet.getByText(/198\.51\.100\.9/).first(),
			).toBeVisible({ timeout: 20_000 });
			await expect(
				sheet.getByText(/This transport stores a secret, which needs an encryption key/),
			).toHaveCount(0);
			await expect(sheet.getByText(/Encryption is not configured/)).toHaveCount(0);
			// A refused verification persists NOTHING, so the sheet stays open on its error rather
			// than closing the way a successful create does (`onOpenChange(false)`).
			await expect(sheet).toBeVisible();
		},
	);
});
