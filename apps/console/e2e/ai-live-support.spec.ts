// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The support "Ask AI" chat (/{org}/~/support/ask → POST /api/support/ask) against a REAL model —
// the AI soak's support lane (epic #7840); nightly at Haiku and on a PR that changes support AI code. Behaviour only: the answer streams to completion without the error
// card, a how-to question is grounded in a tool, and a request to open a case raises the
// person-approval card (`create_support_case` has no execute — nothing is filed until Submit).

import { expect, test, type Page } from "@playwright/test";
import { completedAnswer, completedToolFrame, waitForTurn } from "./helpers/ai-live";
import { personaOrgSlug, seedAiTier, soakTier } from "./helpers/ai-tier";
import { STORAGE_STATE } from "./fixtures/auth";
import { untilPageHydrated } from "./helpers/hydration";

test.skip(!process.env.ANTHROPIC_API_KEY, "needs a real ANTHROPIC_API_KEY on the console under test");
test.setTimeout(240_000);

let orgSlug = "";

/** Send a message through the support chat's composer. */
async function askSupport(page: Page, text: string): Promise<void> {
	// VISIBLE IS NOT INTERACTIVE (helpers/hydration.ts, #5786): the first two live runs filled and
	// submitted this composer before React hydrated it, so the text was dropped and NO request to
	// /api/support/ask was ever made (the traces show none). Wait for hydration, then prove the
	// message was actually sent — it appears in the transcript — before waiting on the model.
	await untilPageHydrated(page);
	const main = page.getByRole("main");
	const composer = main.getByRole("textbox", { name: "Message" });
	await composer.fill(text);
	await expect(composer).toHaveValue(text);
	await main.getByRole("button", { name: "Submit" }).click();
	await expect(main.getByRole("log").getByText(text).first()).toBeVisible({ timeout: 15_000 });
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
