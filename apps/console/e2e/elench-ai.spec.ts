// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench AI journeys, end-to-end through the REAL pipeline. Only the model is
// scripted (ALETHIA_AI_MOCK=1 → lib/config/ai-mock): the agent route, extended-thinking
// options, orchestration markers, tool execution (PDP-gated reads against the real DB),
// metering, transcript persistence, widget auto-pin into `thread_widgets`, artifacts and
// RLS all run for real against Postgres. That's the difference from a client-side SSE
// stub — that never reaches the server at all.
//
// Signed in as the shared persona (the `setup` project) — the subject here is the chat,
// and a signup per test would trip Better Auth's per-IP rate limit. Each test opens a
// NEW chat, so each gets its own thread and therefore its own grid.
//
// Run: ALETHIA_AI_MOCK=1 on the console, then `pnpm test:e2e --project=elench-ai`.

import { expect, test, type Page } from "@playwright/test";

test.skip(
	process.env.ALETHIA_AI_MOCK !== "1",
	"needs the scripted model (ALETHIA_AI_MOCK=1) on the console under test",
);

/** The grid's cell geometry (widget-grid.tsx). */
const ROW_H = 88;
const GRID_GAP = 8;

/**
 * The composer is a Lexical **contenteditable** (role=textbox), not an `<input>` — it carries
 * `aria-placeholder`, never a `placeholder` attribute, so `getByPlaceholder` matches nothing.
 * Address it by testid. (Locating it the old way is exactly how the whole suite silently broke.)
 */
const composer = (page: Page) => page.getByTestId("elench-composer");

/** Open the Elench modal and wait for the thread list to resolve (the body swaps its
 * loading skeleton for the composer only once it's ready). */
async function openModal(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Ask AI" }).click();
	await page.getByRole("button", { name: /expand to full screen/i }).click();
	await expect(page.getByTestId("elench-modal")).toBeVisible();
	await expect(composer(page)).toBeVisible({ timeout: 30_000 });
}

/** Open Elench on a FRESH conversation (persona is shared, so start a new thread). */
async function openFreshChat(page: Page): Promise<void> {
	await page.goto("/");
	await openModal(page);
	// The persona carries earlier tests' threads; start clean so this test owns its grid.
	await page.getByRole("button", { name: /new chat/i }).first().click();
	await expect(composer(page)).toBeVisible({ timeout: 30_000 });
}

/** Reopen the modal after a reload and select the most recent thread. */
async function reopenLatestThread(page: Page): Promise<void> {
	await openModal(page);
	await page.getByTestId("thread-rail-row").first().click();
}

/** Send a message through the composer (type into the contenteditable, then Enter). */
async function ask(page: Page, text: string): Promise<void> {
	const editor = composer(page);
	await editor.click();
	await editor.pressSequentially(text);
	await editor.press("Enter");
	await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
}

const frames = (page: Page) => page.locator('[data-slot="tool-result-frame"]');
const widgets = (page: Page) => page.getByTestId("widget-card");

/** Ask for the 4-block dashboard and wait for its widgets to land on the grid. */
async function seedDashboard(page: Page): Promise<void> {
	await ask(page, "Build a dashboard of my infrastructure");
	await expect(widgets(page)).toHaveCount(4, { timeout: 60_000 });
}

test.describe("Elench with AI responses (scripted model, real pipeline)", () => {
	test.slow();

	test("a tool turn streams reasoning, an orchestration marker, and ONE labeled frame", async ({
		page,
	}) => {
		await openFreshChat(page);
		await ask(page, "Are my connectors healthy?");

		// Reasoning streamed and settled — rendered from REAL reasoning parts (thinking is
		// enabled on every tier since #358).
		await expect(page.getByText(/thought for \d+ seconds?/i).first()).toBeVisible({
			timeout: 60_000,
		});

		// The orchestration marker names ONLY Elench + the phase. The underlying model is an
		// internal detail and must never surface in the transcript (#497).
		await expect(
			page
				.locator('[data-variant="separator"]')
				.filter({ hasText: /elench · (planning|working)/i })
				.first(),
		).toBeVisible();
		await expect(
			page
				.locator('[data-variant="separator"]')
				.filter({ hasText: /claude|haiku|sonnet|opus/i }),
		).toHaveCount(0);

		// The tool ran FOR REAL (a PDP-gated read against this org's connectors) and
		// rendered inside exactly one labeled frame — the unification invariant.
		const frame = frames(page).filter({ hasText: "list_connectors" });
		await expect(frame).toHaveCount(1);
		await expect(frame.getByText("Completed")).toBeVisible();
		await expect(frame.getByText(/\d+ rows/)).toBeVisible();

		// The closing assistant text arrives after the tool result (the follow-up step).
		await expect(page.getByText(/here are your connectors/i)).toBeVisible();

		// The transcript settles with NO reserved spacer gap (the #358 fix).
		await expect(page.locator("[data-message-scroller-spacer]")).toHaveClass(
			/max-h-0/,
		);
	});

	test("a dashboard turn pins its blocks as widgets that survive a reload", async ({
		page,
	}) => {
		await openFreshChat(page);
		await ask(page, "Build a dashboard of my infrastructure");

		// The transcript shows the framed receipt (blocks → widgets).
		await expect(page.getByText(/4 widgets pinned to grid/i)).toBeVisible({
			timeout: 60_000,
		});

		// The grid pane opened itself and holds one widget per block.
		await expect(page.getByTestId("widget-grid")).toBeVisible();
		await expect(widgets(page)).toHaveCount(4);
		await expect(page.getByRole("group", { name: "Active clusters" })).toBeVisible();
		await expect(page.getByRole("group", { name: "Runner minutes" })).toBeVisible();

		// The real proof: they were written to `thread_widgets` — reload, reopen the
		// thread, and the grid rehydrates from Postgres.
		await page.reload();
		await reopenLatestThread(page);
		await expect(widgets(page)).toHaveCount(4, { timeout: 30_000 });
	});

	test("an empty-cell prompt fills exactly the clicked cell", async ({ page }) => {
		await openFreshChat(page);
		await seedDashboard(page);

		// Click the top-right cell — free once the 4 dashboard blocks are placed (they fill
		// columns 1–4) — so the inline composer opens there.
		const grid = page.getByTestId("widget-grid");
		const box = await grid.boundingBox();
		if (!box) throw new Error("grid not laid out");
		const cellW = (box.width - 4 * GRID_GAP) / 5;
		await page.mouse.click(
			box.x + 4 * (cellW + GRID_GAP) + cellW / 2,
			box.y + ROW_H / 2,
		);
		const prompt = page.getByTestId("cell-prompt");
		await expect(prompt).toBeVisible();
		// The cell the composer actually opened in — the widget must land in exactly it.
		const cell = await prompt.evaluate((el) => {
			const s = getComputedStyle(el);
			return { col: s.gridColumnStart, row: s.gridRowStart };
		});

		// Describe the widget → it goes out as a normal chat message carrying the cell
		// target, and the model answers with pin_widget at those coordinates.
		const cellInput = page.getByPlaceholder(/describe what goes here/i);
		await cellInput.fill("running jobs");
		await cellInput.press("Enter");

		await expect(page.getByText(/pinned that to the grid/i)).toBeVisible({
			timeout: 60_000,
		});
		// A FIFTH widget landed (the 4 dashboard blocks plus this one).
		await expect(widgets(page)).toHaveCount(5);
		const pinned = page.getByRole("group", { name: "Jobs", exact: true });
		await expect(pinned).toBeVisible();
		// It landed in the cell the user clicked — the route's cell hint reached the model
		// and came back through pin_widget's position.
		await expect(pinned).toHaveCSS("grid-column-start", cell.col);
		await expect(pinned).toHaveCSS("grid-row-start", cell.row);
	});

	test("a widget's position persists across a reload", async ({ page }) => {
		await openFreshChat(page);
		await seedDashboard(page);

		// Move a widget with the keyboard (deterministic; shares the pointer path's commit).
		// Since #502 the pointer drag is dnd-kit and keyboard mode is armed from the GRIP
		// (Enter/Space) rather than a separate button. Three rows down clears the seeded
		// widgets — a collision would (correctly) revert.
		const card = page.getByRole("group", { name: "Active clusters" });
		const grip = page.getByRole("button", { name: /^Move Active clusters/ });
		await grip.press("Enter"); // arm keyboard-move
		await grip.press("ArrowDown");
		await grip.press("ArrowDown");
		await grip.press("ArrowDown");
		await grip.press("Enter"); // commit
		await expect(card).toHaveCSS("grid-row-start", "4");

		// The move was persisted to `thread_widgets`, not just to local state.
		await page.reload();
		await reopenLatestThread(page);
		await expect(
			page.getByRole("group", { name: "Active clusters" }),
		).toHaveCSS("grid-row-start", "4", { timeout: 30_000 });
	});

	test("save as artifact → open it in a NEW chat → the agent edits it", async ({
		page,
	}) => {
		await openFreshChat(page);
		await seedDashboard(page);

		// Promote the whole grid to a named, org-scoped artifact (unique per run: the
		// name is unique per org by DB constraint).
		const name = `overview-${Date.now()}`;
		await page.getByRole("button", { name: /save dashboard as artifact/i }).click();
		await page.getByPlaceholder("Artifact name").fill(name);
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByText("Saved.")).toBeVisible();

		// A brand-new conversation can see it in the Artifacts library. (An empty chat has no
		// top bar and — since #504 — no open grid, so the rail's Artifacts pane is the surface
		// for this, not the grid-header browser.)
		await page.getByRole("button", { name: /new chat/i }).first().click();
		await page.getByRole("button", { name: "Artifacts", exact: true }).click();
		await expect(page.getByText(name)).toBeVisible();
		await page.getByRole("button", { name: /close artifacts/i }).click();

		// Reference it and ask for an edit → get_artifact THEN update_artifact, both real
		// server calls against the saved row.
		await ask(page, `edit the @${name} artifact`);
		await expect(page.getByText(/updated the artifact/i)).toBeVisible({
			timeout: 60_000,
		});
		await expect(frames(page).filter({ hasText: "get_artifact" })).toHaveCount(1);
		await expect(frames(page).filter({ hasText: "update_artifact" })).toHaveCount(1);
	});
});

test("zzgeom", async ({ page }) => {
	await openFreshChat(page);
	await seedDashboard(page);
	const geo = await page.getByTestId("widget-grid").evaluate((el) => {
		const r = el.getBoundingClientRect();
		const kids = Array.from(el.children).map((c) => {
			const s = getComputedStyle(c);
			return `${(c.getAttribute("aria-label") || c.tagName)}@col${s.gridColumnStart} row${s.gridRowStart} span${s.gridRowEnd}`;
		});
		return { top: r.top, height: r.height, minH: getComputedStyle(el).minHeight, kids };
	});
	console.log("GEOM:", JSON.stringify(geo));
	const btn = await page.getByLabel("Move Active clusters with arrow keys").count();
	console.log("MOVE BTN COUNT:", btn);
});
