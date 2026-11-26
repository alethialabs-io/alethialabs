// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The support "Ask AI" chat (/{org}/~/support/ask → POST /api/support/ask) against a REAL model —
// the AI soak's support lane. Behaviour only: the answer streams to completion without the error
// card, a how-to question is grounded in a tool, and a request to open a case raises the
// person-approval card (`create_support_case` has no execute — nothing is filed until Submit).

import { expect, test, type Page } from "@playwright/test";
import { completedAnswer, completedToolFrame, waitForTurn } from "./helpers/ai-live";
import { personaOrgSlug, seedAiTier, soakTier } from "./helpers/ai-tier";
import { STORAGE_STATE } from "./fixtures/auth";

test.skip(!process.env.ANTHROPIC_API_KEY, "needs a real ANTHROPIC_API_KEY on the console under test");
test.setTimeout(240_000);

let orgSlug = "";

/** Send a message through the support chat's composer. */
async function askSupport(page: Page, text: string): Promise<void> {
	// The support chat's composer is the generic AgentChat one: a textbox named "Message" and an
	// explicit "Submit" button (Enter in a bare fill did not send — measured on the first live run).
	const main = page.getByRole("main");
	await main.getByRole("textbox", { name: "Message" }).fill(text);
	await main.getByRole("button", { name: "Submit" }).click();
}

test.describe(`Support Ask AI with a REAL model · ${soakTier()}`, () => {
	test.beforeAll(async ({ browser }, testInfo) => {
		const context = await browser.newContext({
			storageState: STORAGE_STATE,
			baseURL: testInfo.project.use.baseURL,
		});
		orgSlug = await personaOrgSlug(await context.newPage());
		await context.close();
		await seedAiTier(orgSlug);
	});

	test.beforeEach(async ({ page }) => {
		await page.goto(`/${orgSlug}/~/support/ask`);
	});

	test("answers a how-to, grounded in a tool, without the error card", async ({ page }) => {
		const failure = page.getByRole("main").getByRole("alert");
		await askSupport(page, "How do I connect an AWS account?");
		await waitForTurn(page, completedToolFrame(page, ["search_docs"]).first(), 150_000, failure);
		await waitForTurn(page, completedAnswer(page.getByRole("main")), 150_000, failure);
	});

	test("a request to open a case raises the approval card, and Dismiss files nothing", async ({ page }) => {
		const failure = page.getByRole("main").getByRole("alert");
		await askSupport(
			page,
			"I was charged twice for this month's subscription. Please open a billing support case for me.",
		);
		const submit = page.getByRole("button", { name: "Submit case" }).first();
		await waitForTurn(page, submit, 180_000, failure);
		await page.getByRole("button", { name: "Dismiss" }).first().click();
		await expect(page.getByText("Dismissed.").first()).toBeVisible();
		await expect(submit).toHaveCount(0);
	});
});
