// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E for the Elench agent surface (modal + docked panel) with AI OFF: the chrome +
// interactions — modal empty landing, composer (Ask Elench + @-mention affordance),
// Ask-mode popover, minimize/maximize shared state, thread persistence, and the
// "AI is not configured" 503 path.
//
// The AI JOURNEYS (streaming, tools, grid, artifacts) live in `elench-ai.spec.ts`,
// which drives the REAL server pipeline against a scripted model (ALETHIA_AI_MOCK=1) —
// far stronger than the client-side SSE stubs this file used to carry.

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";

/** Open the Elench surface as a docked panel via the topbar "Ask AI" button. */
async function openElenchPanel(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Ask AI" }).click();
	await expect(page.getByRole("dialog", { name: /elench assistant/i })).toBeVisible();
}

/** Open the Elench surface, then maximize the panel to the fullscreen modal. */
async function openElenchModal(page: Page): Promise<void> {
	await openElenchPanel(page);
	await page.getByRole("button", { name: /expand to full screen/i }).click();
	await expect(page.getByTestId("elench-modal")).toBeVisible();
}

test.describe("Elench agent — modal (org)", () => {
	test.beforeEach(async ({ authedPage: page }) => {
		await openElenchModal(page);
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

		// Minimize to the docked panel — the surface floats over the org home (no route hop).
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

// ─── Deterministic AI-off flows (the stack serves the modal + a 503 route) ───
test.describe("Elench agent — AI-off deterministic flows (org)", () => {
	// The 503 path only exists with AI unconfigured — skip when the scripted E2E model
	// is engaged (that console answers for real; see elench-ai.spec.ts).
	test.skip(
		process.env.ALETHIA_AI_MOCK === "1",
		"the scripted model makes the console AI-configured",
	);
	test.beforeEach(async ({ authedPage: page }) => {
		await openElenchModal(page);
	});

	test("the suggestion carousel pages through its cards", async ({
		authedPage: page,
	}) => {
		const cards = page.getByTestId("elench-suggestion");
		await expect(cards).toHaveCount(3);
		// Page 1 (org suggestions) leads with the connectors chip; dot 1 is current.
		await expect(
			page.getByRole("button", { name: /are my connectors healthy/i }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /suggestions page 1/i }),
		).toHaveAttribute("aria-current", "true");

		await page.getByRole("button", { name: /next suggestions/i }).click();
		// The visible 3 cards changed and the active dot advanced to page 2.
		await expect(
			page.getByRole("button", { name: /are my connectors healthy/i }),
		).toHaveCount(0);
		await expect(page.getByTestId("elench-suggestion")).toHaveCount(3);
		await expect(
			page.getByRole("button", { name: /suggestions page 2/i }),
		).toHaveAttribute("aria-current", "true");

		// A dot jumps directly to that page.
		await page.getByRole("button", { name: /suggestions page 3/i }).click();
		await expect(
			page.getByRole("button", { name: /suggestions page 3/i }),
		).toHaveAttribute("aria-current", "true");
	});

	test("a sent thread persists across a reload", async ({
		authedPage: page,
	}) => {
		const composer = page.getByPlaceholder(/ask elench.*tag a resource/i);
		await composer.fill("persisted elench thread");
		await composer.press("Enter");
		await expect(page.getByText("persisted elench thread")).toBeVisible();

		// The thread is created LAZILY on this first send + titled from it → it shows in the rail.
		const row = page
			.getByTestId("thread-rail-row")
			.filter({ hasText: /persisted elench thread/i });
		await expect(row.first()).toBeVisible();

		// Reload + reopen → the persisted thread resumes (rail row + message survive).
		await page.reload();
		await openElenchModal(page);
		await expect(
			page
				.getByTestId("thread-rail-row")
				.filter({ hasText: /persisted elench thread/i })
				.first(),
		).toBeVisible();
	});

	test("sending with no AI key surfaces the 'AI not configured' error + Retry", async ({
		authedPage: page,
	}) => {
		// The stack runs AI-off by default → /api/agent returns 503; ChatError classifies it
		// as missing-key ("AI is not configured") and always offers a Retry.
		const composer = page.getByPlaceholder(/ask elench.*tag a resource/i);
		await composer.fill("anything at all");
		await composer.press("Enter");
		await expect(page.getByText(/ai is not configured/i)).toBeVisible();
		await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
	});
});
