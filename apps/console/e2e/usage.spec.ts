// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E: the Usage page for a BRAND-NEW org — this spec's whole reason to exist beside
// `e2e/flows/agent-usage-activity.spec.ts`. That file drives the seeded QA personas, which have
// history and a Stripe subscription behind them; this one drives an account created by a real
// email-OTP signup seconds earlier, which has neither. So it asks the two questions that are
// about the WIRING rather than about the numbers: does the page's outline render at all on the
// free plan, and does the range picker reach the card it captions.
//
// Everything about plan gating, the meters, the metric tabs and the Pro surface belongs to the
// flows spec, which can promise Stripe through `fixtures/qa.ts`. THIS spec's fixture
// (`fixtures/auth.ts`) has no capability gate, so a `@needs:stripe` tag here would be a promise
// nothing reads — the exact silent downgrade `e2e/helpers/capabilities.ts` exists to end. It
// therefore asserts nothing that a live subscription answers.
//
// Run locally with `pnpm dev:up` + `pnpm -C apps/console run test:e2e`.

import { expect, test } from "./fixtures/auth";

test.describe("Usage page (a brand-new org)", () => {
	test("the four taxonomy sections render as the page's outline", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/usage`);

		// By role, not by text. `SettingsSection` renders its title through
		// `SectionHeading level={2}`, so these four ARE the document outline — and the old
		// `getByText("AI usage")` asked for a string the console does not contain: the fourth
		// section is titled "AI plan & usage" (ai-usage-section.tsx). It had been recorded
		// `failed` in gate-baseline.json for that alone.
		await expect(
			page.getByRole("heading", { name: "Plan & limits", level: 2 }),
		).toBeVisible({ timeout: 30_000 });
		await expect(
			page.getByRole("heading", { name: "Usage over time", level: 2 }),
		).toBeVisible();
		await expect(page.getByRole("heading", { name: "Resources", level: 2 })).toBeVisible();
		await expect(
			page.getByRole("heading", { name: "AI plan & usage", level: 2 }),
		).toBeVisible();
	});

	test("picking a quick range re-captions the over-time card", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/usage`);
		await expect(
			page.getByRole("heading", { name: "Usage over time", level: 2 }),
		).toBeVisible({ timeout: 30_000 });

		// Anchored names (`^…$`) on both: once the popover is open the preset list carries every
		// label the trigger can carry, so an unanchored /last 7 days/i is two nodes and a strict
		// -mode failure waiting for the second one to be added.
		await page.getByRole("button", { name: /^Last 7 days$/i }).click();
		await page.getByRole("button", { name: "Last 14 days", exact: true }).click();

		// The CARD's caption, not the picker's own trigger label. `OverTimeCard` renders
		// `{noun} · {rangeLabel.toLowerCase()}` (usage-primitives.tsx), so this is the one
		// assertion that proves the new window reached the thing being captioned rather than
		// only the control that was clicked — the flows spec asserts the trigger, and asserting
		// it twice would buy a second copy of one measurement.
		// Anchored: the caption's PARENT also holds the window total, so its text contains this
		// string too, and an unanchored regex would be two nodes and a strict-mode failure.
		await expect(page.getByText(/^runner time · last 14 days$/i)).toBeVisible({
			timeout: 30_000,
		});
	});
});
