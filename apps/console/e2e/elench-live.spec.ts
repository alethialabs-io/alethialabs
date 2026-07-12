// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench journeys against a REAL model (Tier B — nightly, never merge-gating).
// Needs ANTHROPIC_API_KEY on the console under test; skips cleanly without it.
//
// Assertions are deliberately LOOSE and behavioral: a real model's prose and exact tool
// sequence vary run to run, so we assert the shape of the outcome — the turn completes
// without the error state, a tool actually ran and rendered in the unified frame, a
// dashboard request materializes widgets on the grid. Anything tighter is a flake
// factory. The exact-behavior contract lives in the scripted suite (elench-ai.spec.ts).

import { expect, test, type Page } from "@playwright/test";

test.skip(
	!process.env.ANTHROPIC_API_KEY,
	"needs a real ANTHROPIC_API_KEY on the console under test",
);

// Real models think; give them room.
test.setTimeout(180_000);

/** Open Elench on a fresh conversation and maximize it (shared persona). */
async function openElenchModal(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByRole("button", { name: "Ask AI" }).click();
	await page.getByRole("button", { name: /expand to full screen/i }).click();
	await expect(page.getByTestId("elench-modal")).toBeVisible();
	const newChat = page.getByRole("button", { name: /new chat/i }).first();
	if (await newChat.isVisible().catch(() => false)) await newChat.click();
}

/** Send a message through the composer. */
async function ask(page: Page, text: string): Promise<void> {
	const composer = page.getByPlaceholder(/ask elench.*tag a resource/i);
	await composer.fill(text);
	await composer.press("Enter");
}

/** The turn must not have ended in the error state (missing key / budget / network). */
async function expectNoChatError(page: Page): Promise<void> {
	await expect(page.getByText(/ai is not configured/i)).toHaveCount(0);
	await expect(page.getByText(/ai limit reached/i)).toHaveCount(0);
	await expect(page.getByText(/the assistant hit an error/i)).toHaveCount(0);
}

test.describe("Elench with a REAL model (nightly)", () => {
	test.beforeEach(async ({ page }) => {
		await openElenchModal(page);
	});

	test("answers a plain question — streams to completion, no error state", async ({ page }) => {
		await ask(page, "In one sentence, what does Alethia do?");
		// An assistant turn produced text (the copy affordance only appears on a
		// completed assistant message).
		await expect(
			page.getByRole("button", { name: /copy/i }).first(),
		).toBeVisible({ timeout: 120_000 });
		await expectNoChatError(page);
	});

	test("reaches for a real tool when asked about connectors", async ({ page }) => {
		await ask(page, "Are my connectors healthy? Use the tools to check.");
		// SOME tool ran and rendered inside the unified frame — we don't pin which one
		// or how many (a real model may also list identities, etc.).
		await expect(
			page.locator('[data-slot="tool-result-frame"]').first(),
		).toBeVisible({ timeout: 120_000 });
		await expect(
			page.locator('[data-slot="tool-result-frame"]')
				.filter({ hasText: "Completed" })
				.first(),
		).toBeVisible({ timeout: 120_000 });
		await expectNoChatError(page);
	});

	test("composes a dashboard that materializes as widgets on the grid", async ({ page }) => {
		await ask(
			page,
			"Build a dashboard of my infrastructure — clusters, jobs, and runner usage — as stat cards.",
		);
		// However the model gets there (build_dashboard, or pin_widget calls), the grid
		// ends up holding at least one widget.
		await expect(page.getByTestId("widget-card").first()).toBeVisible({
			timeout: 150_000,
		});
		await expectNoChatError(page);
	});
});
