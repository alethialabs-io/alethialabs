// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Regression cover for the Elench surface defects that shipped because nothing drove the UI:
//   · the @-mention menu rendered ON TOP of the text you were typing and could not scroll
//   · clicking an artifact silently created a chat named after it (or hijacked your last one)
//   · the rail carried an orphan "Chats" row and an unpadded search box
// These assert geometry and side-effects — the things a type-check can never see.

import { expect, test, type Page } from "@playwright/test";

const composer = (page: Page) => page.getByTestId("elench-composer");
const menu = (page: Page) => page.getByTestId("mention-menu");
const list = (page: Page) => page.getByTestId("mention-menu-list");

async function openElench(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByRole("button", { name: "Ask AI" }).click();
	await page.getByRole("button", { name: /expand to full screen/i }).click();
	await expect(page.getByTestId("elench-modal")).toBeVisible();
	await expect(composer(page)).toBeVisible({ timeout: 30_000 });
}

test.describe("Elench composer · @-mention menu", () => {
	test("opens ABOVE the composer and never covers the text you're typing", async ({
		page,
	}) => {
		await openElench(page);
		const editor = composer(page);
		await editor.click();
		await editor.pressSequentially("tell me about @");

		await expect(menu(page)).toBeVisible();

		const menuBox = await menu(page).boundingBox();
		const editorBox = await editor.boundingBox();
		expect(menuBox).not.toBeNull();
		expect(editorBox).not.toBeNull();
		if (!menuBox || !editorBox) return;

		// The whole menu sits above the editor's top edge — it must not overlap the input,
		// which is exactly what the caret-anchored version did (it covered the `@`).
		expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(editorBox.y + 1);

		// …and it must not run off the TOP of the viewport either. It opens upward, so on the
		// empty landing (composer mid-screen) a fixed max-height clipped its own header.
		expect(menuBox.y).toBeGreaterThanOrEqual(0);
	});

	test("the results list actually scrolls", async ({ page }) => {
		await openElench(page);
		const editor = composer(page);
		await editor.click();
		await editor.pressSequentially("@");

		await expect(menu(page)).toBeVisible();
		// Wait for the (debounced, async) results to land before measuring — the connector
		// catalog alone comfortably overflows the menu's max height.
		const rows = list(page).getByRole("button");
		await expect.poll(async () => rows.count()).toBeGreaterThan(7);

		const metrics = await list(page).evaluate((el) => ({
			scrollHeight: el.scrollHeight,
			clientHeight: el.clientHeight,
		}));
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

		// And it can be scrolled (the old container was trapped inside a zero-size anchor).
		const scrolled = await list(page).evaluate((el) => {
			el.scrollTop = 120;
			return el.scrollTop;
		});
		expect(scrolled).toBeGreaterThan(0);
	});

	test("↓ then Enter inserts an atomic pill; Backspace deletes it whole", async ({
		page,
	}) => {
		await openElench(page);
		const editor = composer(page);
		await editor.click();
		await editor.pressSequentially("@");
		await expect(menu(page)).toBeVisible();
		// The options are fetched (debounced + server round-trip); pressing Enter before they
		// land has nothing to select. Wait for the list, then drive it.
		await expect
			.poll(async () => list(page).getByRole("button").count())
			.toBeGreaterThan(0);

		// The first row is preselected (Discord), and ↓ walks the list.
		await editor.press("ArrowDown");
		await editor.press("Enter"); // take the highlighted option
		await expect(menu(page)).toBeHidden();

		const pill = editor.locator("[data-mention]");
		await expect(pill).toHaveCount(1);
		const label = await pill.innerText();
		expect(label.startsWith("@")).toBe(true);

		// Token-mode node: ONE backspace removes the entire mention, not a character.
		await editor.press("Backspace"); // eats the trailing space
		await editor.press("Backspace"); // eats the whole pill
		await expect(editor.locator("[data-mention]")).toHaveCount(0);
	});
});

test.describe("Elench rail", () => {
	test("has no orphan 'Chats' nav row, and the search box has real padding", async ({
		page,
	}) => {
		await openElench(page);

		// The workspace is a switcher control, not a nav row that does nothing.
		await expect(
			page.getByRole("button", { name: "Chats", exact: true }),
		).toHaveCount(0);
		await expect(page.getByTestId("workspace-switcher")).toBeVisible();

		const padding = await page
			.getByPlaceholder(/search chats/i)
			.evaluate((el) => getComputedStyle(el).paddingLeft);
		expect(Number.parseFloat(padding)).toBeGreaterThan(0);
	});
});

test.describe("Elench knowledge base", () => {
	test("a named document saves, survives a reload, and counts against capacity", async ({
		page,
	}) => {
		await openElench(page);
		await page.getByRole("button", { name: "Knowledge", exact: true }).click();
		await expect(page.getByTestId("knowledge-panel")).toBeVisible();

		// It is a document LIST, not a textarea blob.
		await expect(page.getByTestId("knowledge-doc")).toHaveCount(0);
		await page.getByTestId("knowledge-add").click();

		const title = `Runbook ${Date.now()}`;
		await page.getByTestId("knowledge-doc-title").fill(title);
		await page
			.getByTestId("knowledge-doc-content")
			.fill("Drain nodes before an apply. Owned by the platform team.");
		await page.getByTestId("knowledge-doc-save").click();

		const doc = page.getByTestId("knowledge-doc");
		await expect(doc).toHaveCount(1);
		await expect(doc).toContainText(title);
		// The capacity meter reflects real size — knowledge is paid for on every turn.
		await expect(page.getByTestId("knowledge-panel")).toContainText("/ 50.0k");

		// Wait for the write to land before navigating — reloading over an in-flight server
		// action aborts it (that's what "Saved." is there to tell you).
		await expect(page.getByText("Saved.")).toBeVisible();

		// It PERSISTED (a server row, not local state).
		await page.reload();
		await openElench(page);
		await page.getByRole("button", { name: "Knowledge", exact: true }).click();
		await expect(page.getByTestId("knowledge-doc")).toContainText(title);

		// And it can be removed again.
		await page.getByRole("button", { name: `Delete ${title}` }).click();
		await expect(page.getByTestId("knowledge-doc")).toHaveCount(0);
	});
});

test.describe("Elench artifacts", () => {
	test("clicking an artifact opens a viewer and does NOT create a chat", async ({
		page,
	}) => {
		await openElench(page);

		// Seed one artifact through the real pipeline.
		const editor = composer(page);
		await editor.click();
		await editor.pressSequentially("Build a dashboard of my infrastructure");
		await editor.press("Enter");
		await expect(page.getByTestId("widget-card")).toHaveCount(4, {
			timeout: 60_000,
		});
		const name = `viewer-${Date.now()}`;
		await page.getByRole("button", { name: /save dashboard as artifact/i }).click();
		await page.getByPlaceholder("Artifact name").fill(name);
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByText("Saved.")).toBeVisible();

		// Open the library and count the conversations BEFORE clicking the artifact.
		await page.getByRole("button", { name: "Artifacts", exact: true }).click();
		const threadsBefore = await page.getByTestId("thread-rail-row").count();

		await page.getByTestId("artifact-card").filter({ hasText: name }).click();

		// It opens a VIEWER — and creates nothing. The old code called startThread(name).
		await expect(page.getByTestId("artifact-viewer")).toBeVisible();
		await expect(page.getByTestId("artifact-viewer")).toContainText(name);
		expect(await page.getByTestId("thread-rail-row").count()).toBe(threadsBefore);
	});
});
