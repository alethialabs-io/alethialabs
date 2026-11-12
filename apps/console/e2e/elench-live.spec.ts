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

import { expect, test, type Locator, type Page } from "@playwright/test";

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
	const composer = page.getByTestId("elench-composer");
	await composer.fill(text);
	await composer.press("Enter");
}

/**
 * The chat's error card: `ChatError` renders an `alert` inside the transcript (the Elench dialog's
 * "Messages" region), whatever its kind — missing key, budget, provider, network. Matched by role,
 * not copy, so a reworded card cannot slip past. Scoped to the transcript so the composer's own
 * too-long alert and the draft decision bars, which sit outside it, are not read as a failed turn.
 */
function chatErrorAlert(page: Page): Locator {
	return page
		.getByRole("dialog", { name: "Elench" })
		.getByRole("region", { name: "Messages" })
		.getByRole("alert");
}

/**
 * Wait until `success` is visible OR the chat shows its error card, whichever comes first. On the
 * error card the test fails at once with the card's text, rather than waiting out the whole budget
 * for a success locator that can no longer appear (#6616).
 */
async function waitForTurn(page: Page, success: Locator, timeout: number): Promise<void> {
	const alert = chatErrorAlert(page);
	await expect(success.or(alert).first()).toBeVisible({ timeout });
	if (await alert.first().isVisible()) {
		const text = (await alert.first().innerText()).replace(/\s+/g, " ").trim();
		throw new Error(`The chat showed an error instead of the answer: ${text}`);
	}
}

/** The turn must not have ended in the error state: the chat's error card is absent. */
async function expectNoChatError(page: Page): Promise<void> {
	await expect(chatErrorAlert(page)).toHaveCount(0);
}

test.describe("Elench with a REAL model (nightly)", () => {
	test.beforeEach(async ({ page }) => {
		await openElenchModal(page);
	});

	test("answers a plain question — streams to completion, no error state", async ({ page }) => {
		await ask(page, "In one sentence, what does Alethia do?");
		// An assistant turn produced text (the copy affordance only appears on a
		// completed assistant message).
		await waitForTurn(page, page.getByRole("button", { name: /copy/i }).first(), 120_000);
		await expectNoChatError(page);
	});

	test("reaches for a real tool when asked about connectors", async ({ page }) => {
		await ask(page, "Are my connectors healthy? Use the tools to check.");
		// SOME tool ran and rendered inside the unified frame — we don't pin which one
		// or how many (a real model may also list identities, etc.).
		await waitForTurn(page, page.locator('[data-slot="tool-result-frame"]').first(), 120_000);
		await waitForTurn(
			page,
			page.locator('[data-slot="tool-result-frame"]').filter({ hasText: "Completed" }).first(),
			120_000,
		);
		await expectNoChatError(page);
	});

	test("composes a dashboard that materializes as widgets on the grid", async ({ page }) => {
		await ask(
			page,
			"Build a dashboard of my infrastructure — clusters, jobs, and runner usage — as stat cards.",
		);
		// However the model gets there (build_dashboard, or pin_widget calls), the grid
		// ends up holding at least one widget.
		await waitForTurn(page, page.getByTestId("widget-card").first(), 150_000);
		await expectNoChatError(page);
	});
});
