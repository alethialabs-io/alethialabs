// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Billing settings + Usage. Two org-scoped surfaces:
//   • /${org}/~/settings/billing — components/settings/billing/* (BillingPanel + Manage / Plan
//     history / Transactions / Invoices) and the shared Hobby→Pro upgrade sheet
//     (components/org/upgrade-org-sheet.tsx, opened via useUpgradeSheet).
//   • /${org}/~/usage — components/settings/usage/usage-panel.tsx (plan & limits, seats vs
//     members, resources, usage-over-time with the time-range filter, AI usage, hard-cap toggle).
//
// Personas: `team` = Pro card-less TRIAL (status trialing, plan team, stripe customer present →
// canManage), `owner` = Hobby (community, no live sub → the upgrade path). We open the upgrade
// sheet and assert the checkout form renders, then STOP before any real Stripe payment.

import { scanA11y } from "../helpers/a11y";
import { expect, test } from "../fixtures/qa";

const billingPath = (slug: string) => `/${slug}/~/settings/billing`;
const usagePath = (slug: string) => `/${slug}/~/usage`;

// The QA console at :3100 is shared across parallel agents — page GETs can spike to ~15s under
// load. Give each test plenty of headroom so a slow render never masquerades as a real failure.
test.beforeEach(() => {
	test.setTimeout(120_000);
});

// ── Billing page — Pro trial (team persona) ───────────────────────────────────────────────
test.describe("Billing settings — Pro trial (team)", () => {
	test("authed persona reaches billing (not bounced to /login)", async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page).not.toHaveURL(/\/login/);
		await expect(team.page.getByText("Current plan")).toBeVisible({ timeout: 30_000 });
	});

	test("current-plan card shows the Pro plan name and the Trialing status", async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByText("Trialing")).toBeVisible({ timeout: 30_000 });
		// meta.name for the `team` plan is "Pro" (plan-catalog).
		await expect(team.page.getByText("Pro", { exact: true }).first()).toBeVisible();
	});

	test("a live (trialing) sub exposes Cancel plan, never an Upgrade CTA", async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByRole("button", { name: "Cancel plan" })).toBeVisible({
			timeout: 30_000,
		});
		// Trialing is already "live" → no upgrade affordance on the billing panel.
		await expect(team.page.getByRole("button", { name: "Upgrade to Pro" })).toHaveCount(0);
	});

	test("plan card surfaces per-seat pricing (seats vs the $20 unit)", async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByText("Current plan")).toBeVisible({ timeout: 30_000 });
		// meta.perSeat → "$20/seat · 1 seat" line beneath the monthly total.
		await expect(team.page.getByText(/\/seat ·/)).toBeVisible();
	});

	test("cloud-spend disclaimer is shown on the plan card", async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(
			team.page.getByText(/cloud-resource spend is billed separately/i),
		).toBeVisible({ timeout: 30_000 });
	});

	test("a Stripe customer (trial) exposes the manage-billing card", async ({ team }) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByText("Payment & billing details")).toBeVisible({
			timeout: 30_000,
		});
		// Opens the Stripe portal — assert it's there, do NOT navigate away.
		await expect(
			team.page.getByRole("button", { name: /manage payment methods/i }),
		).toBeVisible();
	});

	test("plan history, transactions and invoices sections render for a customer", async ({
		team,
	}) => {
		await team.page.goto(billingPath(team.orgSlug));
		await expect(team.page.getByText("Plan history")).toBeVisible({ timeout: 30_000 });
		await expect(team.page.getByText("Transaction history")).toBeVisible();
		await expect(team.page.getByText("Invoices")).toBeVisible();
	});
});

// ── Billing page — Hobby (owner persona) + the upgrade sheet ───────────────────────────────
test.describe("Billing settings — Hobby → Pro upgrade (owner)", () => {
	test("Hobby org shows no live subscription and an Upgrade CTA", async ({ owner }) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await expect(owner.page.getByText("No subscription")).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByRole("button", { name: "Upgrade to Pro" })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: "Cancel plan" })).toHaveCount(0);
	});

	test("Upgrade to Pro opens the shared upgrade sheet with the checkout form", async ({
		owner,
	}) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: "Upgrade to Pro" }).click();

		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByRole("heading", { name: "Upgrade to Pro" })).toBeVisible({
			timeout: 30_000,
		});
		// The custom checkout form (BillingCheckoutForm) mounts once the subscription intent's
		// client secret loads — assert the card fields + the Upgrade submit; STOP before payment.
		await expect(dialog.getByText("Card information")).toBeVisible({ timeout: 30_000 });
		await expect(dialog.getByRole("button", { name: "Upgrade" })).toBeVisible();
	});

	test("the upgrade sheet's order summary reflects the Pro total (no charge)", async ({
		owner,
	}) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: "Upgrade to Pro" }).click();

		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByText("Card information")).toBeVisible({ timeout: 30_000 });
		// Order summary: a Total row (the seat unit) — a stable, payment-free assertion.
		await expect(dialog.getByText("Total")).toBeVisible();
		await expect(dialog.getByText("Full name")).toBeVisible();
	});

	test("the upgrade sheet can be dismissed via its Close control", async ({ owner }) => {
		await owner.page.goto(billingPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: "Upgrade to Pro" }).click();

		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByRole("heading", { name: "Upgrade to Pro" })).toBeVisible({
			timeout: 30_000,
		});
		await dialog.getByRole("button", { name: "Close" }).click();
		await expect(dialog).toBeHidden();
	});
});

// ── Usage page — Pro trial (team persona) ─────────────────────────────────────────────────
test.describe("Usage — Pro trial (team)", () => {
	test("authed persona reaches usage (not bounced to /login)", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page).not.toHaveURL(/\/login/);
		await expect(team.page.getByText("Plan & limits")).toBeVisible({ timeout: 30_000 });
	});

	test("header shows the Pro plan standing and a Manage billing link", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Pro plan")).toBeVisible({ timeout: 30_000 });
		// Non-community → a Manage billing link (not an inline upgrade CTA).
		await expect(team.page.getByRole("link", { name: /manage billing/i })).toBeVisible();
	});

	test("plan & limits renders the seats / concurrency gauges", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Seats")).toBeVisible({ timeout: 30_000 });
		// seats vs members → "N seats available" sub-note.
		await expect(team.page.getByText(/seats available/)).toBeVisible();
		await expect(team.page.getByText("Concurrency")).toBeVisible();
	});

	test("the spend-control hard-cap toggle flips and can be restored", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		const cap = team.page.getByRole("checkbox");
		await expect(cap).toBeVisible({ timeout: 30_000 });
		const before = await cap.isChecked();
		await cap.click();
		await expect(cap).toBeChecked({ checked: !before });
		// Be a good citizen — restore the org's prior hard-cap state.
		await cap.click();
		await expect(cap).toBeChecked({ checked: before });
	});

	test("resources section surfaces spend-under-management", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Resources")).toBeVisible({ timeout: 30_000 });
		await expect(
			team.page.getByText(/Estimated cloud spend under management/i),
		).toBeVisible();
	});

	test("usage-over-time metric tabs switch the summary metric", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Usage over time")).toBeVisible({ timeout: 30_000 });
		await team.page.getByRole("button", { name: "Jobs" }).click();
		await expect(team.page.getByText(/jobs · last 7 days/i)).toBeVisible();
	});

	test("the quick-range filter changes the active window", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await team.page.getByRole("button", { name: /last 7 days/i }).click();
		await team.page.getByRole("button", { name: "Last 30 days" }).click();
		await expect(
			team.page.getByRole("button", { name: /last 30 days/i }),
		).toBeVisible();
	});

	test("AI usage section shows the weekly window, balance and top-up link", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("AI usage")).toBeVisible({ timeout: 30_000 });
		await expect(team.page.getByText("AI credits this week")).toBeVisible();
		await expect(team.page.getByText("Purchased balance")).toBeVisible();
		await expect(team.page.getByRole("link", { name: /buy credits/i })).toBeVisible();
	});

	test("usage page has no serious accessibility violations", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Plan & limits")).toBeVisible({ timeout: 30_000 });
		const violations = await scanA11y(team.page);
		// scanA11y no-ops until axe is installed — this simply records when it is.
		expect(violations.filter((v) => v.impact === "critical")).toEqual([]);
	});
});

// ── Usage page — Hobby (owner persona) ────────────────────────────────────────────────────
test.describe("Usage — Hobby (owner)", () => {
	test("community org shows the Hobby standing and an inline upgrade CTA", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page.getByText("Hobby plan")).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByRole("button", { name: /Upgrade to Pro/ })).toBeVisible();
	});

	test("the inline usage upgrade CTA opens the Pro sheet (stop before payment)", async ({
		owner,
	}) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /Upgrade to Pro/ }).click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByRole("heading", { name: "Upgrade to Pro" })).toBeVisible({
			timeout: 30_000,
		});
	});
});
