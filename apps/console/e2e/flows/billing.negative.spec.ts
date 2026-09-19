// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E (negatives / empty states / validation) for Billing + Usage.
//   • Plan history for an org that has never paid: NOT the empty state — see below.
//   • Entitlement gating: a community (Hobby) org has no spend-control hard-cap toggle and no
//     Stripe manage-billing surface. Both read the org's PLAN, which nothing in the run mutates —
//     unlike its Stripe customer, which the upgrade sheet creates as a side effect (see the note
//     in the first describe block).
//   • Validation: the usage over-time quick-range accepts free-text; a garbage entry shows the
//     inline "Try …" error and does NOT change the window.
//
// Every test here carries `@needs:stripe` for the same reason billing.spec.ts does: without Stripe
// the panel short-circuits to "Self-managed deployment" and none of these surfaces exist to be
// absent from. See that file's header, and e2e/helpers/capabilities.ts.
//
// `member` (reduced-perms) billing negatives are still unwritten. The persona itself EXISTS as of
// #3633 (e2e/global-setup.ts builds it via the real invite → accept flow); what is missing here is
// the spec, not the fixture — so this is a coverage gap to fill, not a blocked one.

import { expect, test } from "../fixtures/qa";

const billingPath = (slug: string) => `/${slug}/~/settings/billing`;
const usagePath = (slug: string) => `/${slug}/~/usage`;

// Shared QA console under parallel load — allow generous per-test time (see billing.spec.ts).
test.beforeEach(() => {
	test.setTimeout(120_000);
});

test.describe("Billing — empty & entitlement-gated (Hobby)", () => {
	// THE EMPTY STATE THIS USED TO ASSERT CANNOT HAPPEN FOR AN ORG. `getPlanHistory` synthesises
	// an "Organization created" entry from `organization.created_at` before it looks at billing at
	// all, and only returns `[]` for a personal scope or an org row it cannot find. So
	// "No plan history yet." was a string the timeline can render and this page never reaches —
	// the test failed on every run and named the copy rather than the cause.
	test("a Hobby org's plan history is its creation, not an empty state", { tag: "@needs:stripe" }, async ({
		owner,
	}) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await expect(owner.page.getByRole("heading", { name: "Plan history" })).toBeVisible({
			timeout: 30_000,
		});
		// The entry only appears once the (best-effort) plan-history fetch resolves.
		await expect(owner.page.getByText("Organization created")).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByText("started on the Free plan.")).toBeVisible();
		await expect(owner.page.getByText("No plan history yet.")).toHaveCount(0);
	});

	// THERE IS NO "A HOBBY ORG HAS NO STRIPE CUSTOMER" TEST HERE, and the reason is worth writing
	// down because it is not obvious from either file. `summary.canManage` is
	// `Boolean(billing.stripeCustomerId)`, and `createSubscriptionIntent` — which the upgrade
	// sheet fires the instant it OPENS — calls `ensureCustomer` and persists the id. So the moment
	// any spec in this run opens the Hobby persona's upgrade sheet, that org has a Stripe customer
	// and the three customer-only sections appear. The suite is `fullyParallel`, so a test
	// asserting their absence would pass or fail on worker ordering: a flake wearing an
	// entitlement assertion's clothes. The gating that IS stable is asserted below, off the usage
	// page, which reads the PLAN rather than the customer.
});

test.describe("Usage — entitlement gating & range validation", () => {
	test("community org has no hard-cap toggle (spend control is a paid control)", { tag: "@needs:stripe" }, async ({
		owner,
	}) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page.getByText("Plan & limits")).toBeVisible({ timeout: 30_000 });
		// The hard-cap checkbox only renders for a non-community usage plan.
		await expect(owner.page.getByRole("checkbox")).toHaveCount(0);
	});

	test("community usage header offers upgrade, not Manage billing", { tag: "@needs:stripe" }, async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page.getByText("Hobby plan")).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByRole("link", { name: /manage billing/i })).toHaveCount(0);
	});

	test("an unparseable quick-range entry surfaces the inline error", { tag: "@needs:stripe" }, async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await team.page.getByRole("button", { name: /last 7 days/i }).click();
		const input = team.page.getByPlaceholder("e.g. 10d, 2 weeks");
		await input.fill("not-a-real-range");
		await input.press("Enter");
		await expect(team.page.getByText(/Try "10d"/)).toBeVisible();
		// The popover stays open (rejected) — the trigger window is unchanged.
		await expect(input).toBeVisible();
	});
});
