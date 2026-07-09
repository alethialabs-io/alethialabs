// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E for the Elench agent surface (modal + docked panel). Covers the ported design's
// chrome + interactions: the modal empty landing, the composer (Ask Elench + @-mention
// affordance), the Ask-mode popover, minimize/maximize shared state, and the panel.
// AI-dependent streaming is not asserted (the route is 503 without ANTHROPIC_API_KEY);
// the optimistic user message is enough to prove the conversation survives a view flip.

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures/auth";
import {
	proposeOperationChunks,
	stubAgentStream,
	textThenDashboardChunks,
} from "./helpers/ai-stream";
import type { DashboardSpec } from "../types/jsonb.types";

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

// ─── Deterministic AI-off flows (no stubbing; the stack serves the modal + a 503 route) ───
test.describe("Elench agent — AI-off deterministic flows (org)", () => {
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

// ─── Stubbed streaming flows: page.route() fulfills a canned AI-SDK UI-message stream ───
// These do NOT need a live model/key — the SSE stub (helpers/ai-stream) replays exactly what
// `toUIMessageStreamResponse` frames and `useChat` parses.
test.describe("Elench agent — stubbed streaming (org)", () => {
	const SPEC: DashboardSpec = {
		title: "Infrastructure overview",
		blocks: [
			{ kind: "stat", title: "Clusters", value: 4, sub: "live" },
			{
				kind: "bar",
				title: "Jobs by provider",
				data: [
					{ label: "aws", value: 12 },
					{ label: "gcp", value: 3 },
				],
			},
			{ kind: "line", title: "Runner minutes", points: [10, 20, 30, 25] },
		],
	};

	test("streams text + a build_dashboard tool part → Open dashboard opens the split pane", async ({
		authedPage: page,
	}) => {
		await stubAgentStream(
			page,
			textThenDashboardChunks("Here is your infrastructure overview.", SPEC),
		);
		await openElenchModal(page);

		const composer = page.getByPlaceholder(/ask elench.*tag a resource/i);
		await composer.fill("build me a dashboard");
		await composer.press("Enter");

		// The streamed assistant text renders, then the generative-dashboard result card.
		await expect(
			page.getByText("Here is your infrastructure overview."),
		).toBeVisible();
		await expect(page.getByText("Dashboard ready")).toBeVisible();
		await page.getByRole("button", { name: /open dashboard/i }).click();

		// The artifact split pane opens with the stat/bar/line block titles from the spec.
		await expect(page.getByText("Clusters")).toBeVisible();
		await expect(page.getByText("Jobs by provider")).toBeVisible();
		await expect(page.getByText("Runner minutes")).toBeVisible();
	});

	test("streams a HITL propose_operation → Approve fires the addToolResult follow-up request", async ({
		authedPage: page,
	}) => {
		const stub = await stubAgentStream(
			page,
			proposeOperationChunks({
				label: "Plan ai-platform",
				operation: { operation: "plan_project", projectId: "proj-e2e" },
				stats: { add: 3, change: 1, destroy: 0, monthly: 120 },
			}),
		);
		await openElenchModal(page);

		const composer = page.getByPlaceholder(/ask elench.*tag a resource/i);
		await composer.fill("plan my project");
		await composer.press("Enter");

		// The HITL approval card renders from the input-available tool part.
		await expect(page.getByText("Plan ai-platform")).toBeVisible();
		const approve = page.getByRole("button", { name: /approve & plan/i });
		await expect(approve).toBeVisible();
		await approve.click();

		// Approving feeds the outcome back via addToolResult; sendAutomaticallyWhen resumes the
		// run → a SECOND request to the streaming route. (The plan action may deny a fake project,
		// but the outcome still resolves the HITL loop, so the follow-up request fires either way.)
		await expect.poll(() => stub.callCount()).toBeGreaterThanOrEqual(2);
	});
});
