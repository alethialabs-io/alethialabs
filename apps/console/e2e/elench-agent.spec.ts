// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E for the Elench agent surface (modal + docked panel). Covers the ported design's
// chrome + interactions: the modal empty landing, the composer (Ask Elench + @-mention
// affordance), the Ask-mode popover, minimize/maximize shared state, and the panel.
// AI-dependent streaming is not asserted (the route is 503 without AI_GATEWAY_API_KEY);
// the optimistic user message is enough to prove the conversation survives a view flip.

import { test, expect } from "./fixtures/auth";

test.describe("Elench agent — modal (org)", () => {
	test.beforeEach(async ({ authedPage: page, orgSlug }) => {
		await page.goto(`/${orgSlug}/~/agent`);
	});

	test("opens as a fullscreen modal with the empty landing", async ({
		authedPage: page,
	}) => {
		await expect(
			page.getByRole("heading", { name: /what should we do today/i }),
		).toBeVisible();
		// The composer is rebranded to Elench with the @-mention affordance.
		await expect(page.getByPlaceholder(/ask elench.*tag a resource/i)).toBeVisible();
		// Suggestion chips wired to the org suggestions.
		await expect(
			page.getByRole("button", { name: /are my connectors healthy/i }),
		).toBeVisible();
		// The "Draw, describe, go." visualization section is ported.
		await expect(page.getByText(/draw, describe, go/i)).toBeVisible();
	});

	test("Ask-mode popover switches ask ↔ auto", async ({ authedPage: page }) => {
		await page.getByRole("button", { name: "Ask", exact: true }).first().click();
		await expect(page.getByText("Ask before editing")).toBeVisible();
		await expect(page.getByText("Automatically edit")).toBeVisible();
		await page.getByText("Automatically edit").click();
		// The pill reflects the active mode.
		await expect(
			page.getByRole("button", { name: "Auto", exact: true }).first(),
		).toBeVisible();
	});

	test("the @-mention popover opens against real resources", async ({
		authedPage: page,
	}) => {
		const composer = page.getByPlaceholder(/ask elench.*tag a resource/i);
		await composer.click();
		await composer.pressSequentially("@");
		// The picker header appears (results depend on the account's resources).
		await expect(page.getByText(/tag a resource/i)).toBeVisible();
	});

	test("minimize → panel → maximize preserves the conversation", async ({
		authedPage: page,
		orgSlug,
	}) => {
		// Send a message (optimistic user turn survives even when AI is unconfigured).
		const composer = page.getByPlaceholder(/ask elench.*tag a resource/i);
		await composer.fill("elench e2e ping");
		await composer.press("Enter");
		await expect(page.getByText("elench e2e ping")).toBeVisible();

		// Minimize to the docked panel — the opener leaves the blank route for the org home.
		await page.getByRole("button", { name: /minimize to panel/i }).click();
		const panel = page.getByRole("dialog", { name: /elench assistant/i });
		await expect(panel).toBeVisible();
		await expect(page).toHaveURL(new RegExp(`/${orgSlug}(\\?.*)?$`));
		// The conversation survived the view flip.
		await expect(panel.getByText("elench e2e ping")).toBeVisible();

		// Maximize back to the modal — still there.
		await page.getByRole("button", { name: /expand to full screen/i }).click();
		await expect(page.getByText("elench e2e ping")).toBeVisible();
	});

	test("the panel closes", async ({ authedPage: page }) => {
		await page.getByRole("button", { name: /minimize to panel/i }).click();
		const panel = page.getByRole("dialog", { name: /elench assistant/i });
		await expect(panel).toBeVisible();
		await page.getByRole("button", { name: /close assistant/i }).click();
		await expect(panel).toBeHidden();
	});
});
