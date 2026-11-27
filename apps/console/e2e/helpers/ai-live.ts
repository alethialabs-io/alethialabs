// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared moves for the REAL-model journeys (the `elench-live` project: elench-live.spec.ts and the
// ai-live-*.spec.ts soak specs). Every locator is a role, a test id or a data-slot — never model
// prose — because a real model's wording and exact tool sequence vary from run to run.

import { expect, type Locator, type Page } from "@playwright/test";

/** Open Elench from the org home, maximize it, and start a fresh conversation. */
export async function openElenchModal(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByRole("button", { name: "Ask AI" }).click();
	await page.getByRole("button", { name: /expand to full screen/i }).click();
	await expect(page.getByTestId("elench-modal")).toBeVisible();
	const newChat = page.getByRole("button", { name: /new chat/i }).first();
	if (await newChat.isVisible().catch(() => false)) await newChat.click();
}

/** Send a message through the Elench composer. */
export async function ask(page: Page, text: string): Promise<void> {
	const composer = page.getByTestId("elench-composer");
	await composer.fill(text);
	await composer.press("Enter");
}

/**
 * The chat's error card inside the Elench transcript (`ChatError` renders an `alert` in the dialog's
 * "Messages" region, whatever its kind). Matched by role, not copy.
 */
export function chatErrorAlert(page: Page): Locator {
	return page
		.getByRole("dialog", { name: "Elench" })
		.getByRole("region", { name: "Messages" })
		.getByRole("alert");
}

/**
 * Wait until `success` is visible OR `failure` (the chat's error card by default) is, and fail at once
 * with the card's text in the second case rather than waiting out the budget (#6616).
 */
export async function waitForTurn(
	page: Page,
	success: Locator,
	timeout: number,
	failure: Locator = chatErrorAlert(page),
): Promise<void> {
	await expect(success.or(failure).first()).toBeVisible({ timeout });
	if (await failure.first().isVisible()) {
		const text = (await failure.first().innerText()).replace(/\s+/g, " ").trim();
		throw new Error(`The chat showed an error instead of the answer: ${text}`);
	}
}

/** A completed tool frame for one of `tools` (the frame carries the tool's name and its status). */
export function completedToolFrame(page: Page, tools: string[]): Locator {
	const name = new RegExp(tools.map((t) => t.replace(/_/g, "[_ ]")).join("|"), "i");
	return page
		.locator('[data-slot="tool-result-frame"]')
		.filter({ hasText: name })
		.filter({ hasText: "Completed" });
}

/** The completion affordance of an assistant turn (copy only renders on a finished message). */
export function completedAnswer(scope: Page | Locator): Locator {
	return scope.getByRole("button", { name: /copy/i }).first();
}
