// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E (negatives / empty states / validation) for Billing + Usage.
//   • Plan history for an org that has never paid: NOT the empty state — see below.
//   • Entitlement gating: a Hobby org has no Stripe customer, so `canManage` is false and the
//     three customer-only sections do not render at all. The POSITIVE half of this pair is in
//     billing.spec.ts ("plan history, transactions and invoices sections render for a customer");
//     without it, this file would be asserting an absence that could pass on a broken page.
//   • Entitlement gating: a community (Hobby) org has no spend-control hard-cap toggle and no
//     Stripe manage-billing surface.
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

	test("a Hobby org has no Stripe customer, so the customer-only sections do not render", { tag: "@needs:stripe" }, async ({
		owner,
	}) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		// Wait for a section the page ALWAYS renders before asserting the three absences —
		// otherwise all three pass instantly against a page that has not finished loading.
		await expect(owner.page.getByRole("heading", { name: "Plan history" })).toBeVisible({
			timeout: 30_000,
		});
		await expect(owner.page.getByRole("heading", { name: "Payment methods" })).toHaveCount(0);
		await expect(owner.page.getByRole("heading", { name: "Transaction history" })).toHaveCount(0);
		await expect(owner.page.getByRole("heading", { name: "Invoices" })).toHaveCount(0);
	});
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
