// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// End-to-end proof of the Architecture canvas, driven through the real app: the per-service fact
// cards, the Secrets vault (a project with 30–40 secrets must not be 30–40 cards), the VPC/cluster
// regions, and the definition panel's newly-definable fields.
//
// Hermetic: reuses the shared OTP-signed-up persona (the `setup` project) and designs on the canvas
// WITHOUT connecting a cloud account — "Create empty project" needs only a name, and the palette
// explicitly supports designing before a cloud is connected. No external services.
//
// Assertions are scoped to the BOARD (`.react-flow`) or the PANEL, never the whole page: the same
// words legitimately appear in both (a bucket's "Access" fact and the inspector's "Access" section),
// and an unscoped query can't tell them apart.

import { test, expect, type Page } from "@playwright/test";

test.describe("Architecture canvas", () => {
	// Runs on the `canvas` project: ONE shared persona from the `setup` project, not a signup per
	// test — a handful of hermetic signups in a row trips Better Auth's per-IP rate limit (the same
	// reason the Elench specs share one). The budget covers `next dev` compiling on first hit.
	test.setTimeout(180_000);

	/** The board itself — everything drawn on the canvas. */
	const board = (page: Page) => page.locator(".react-flow");

	test.beforeEach(async ({ page }, testInfo) => {
		// The stored session lands on the org; read the slug off the URL rather than signing up again.
		await page.goto("/");
		await page.waitForURL((url) => /^\/[^/]+/.test(url.pathname), { timeout: 60_000 });
		const orgSlug = new URL(page.url()).pathname.replace(/^\//, "").replace(/\/.*$/, "");
		expect(orgSlug, "resolved an org slug from the stored session").toBeTruthy();

		// "Create empty project" needs only a NAME — no cloud identity — which is what keeps this
		// hermetic. A unique name per test gives each its own project, so they stay independent.
		await page.goto(`/${orgSlug}/~/new`);
		await page
			.locator("#project_name")
			.fill(`canvas-e2e-${testInfo.workerIndex}-${Date.now()}`);
		await page.getByRole("button", { name: /create empty project/i }).click();

		// The canvas is ready once its toolbar is painted. (The Add button is always present on an
		// editable, non-IaC-governed board; the old "Project settings" cog this used to key on was
		// removed in #554.)
		await expect(
			page.getByRole("button", { name: "Add", exact: true }).first(),
		).toBeVisible({ timeout: 60_000 });
	});

	/** Open the Add palette and drop a service (only kinds with no variant step). */
	async function addService(page: Page, name: string) {
		// The palette's Add button lives on the board's toolbar; list fields in the panel also have an
		// "Add", so scope to the toolbar's exact one.
		await page.getByRole("button", { name: "Add", exact: true }).first().click();
		const search = page.getByPlaceholder(/search services/i);
		await expect(search).toBeVisible();
		await search.fill(name);
		await page.getByRole("option", { name: new RegExp(name, "i") }).first().click();
		await expect(search).toBeHidden();
	}

	test("a service card shows the facts that matter for THAT service", async ({
		page,
	}) => {
		await addService(page, "Bucket");

		// The bucket's fact grid — access · versioning · CORS. This is what makes a bucket read
		// differently from a database on a canvas that has no colour to spend.
		// Target the bucket's OWN card: a new project already ships a network and a cluster, so
		// `.first()` would assert against the wrong node.
		const card = board(page).locator(".react-flow__node-bucket");
		await expect(card.getByText("Access", { exact: true })).toBeVisible();
		await expect(card.getByText("private", { exact: true })).toBeVisible();
		await expect(card.getByText("Versioning", { exact: true })).toBeVisible();
		await expect(card.getByText("CORS", { exact: true })).toBeVisible();
	});

	test("a card goes Needs-setup the moment its config stops being deployable", async ({
		page,
	}) => {
		await addService(page, "NoSQL");
		const card = board(page).locator(".react-flow__node-nosql");

		// A freshly-added table is VALID (it defaults its partition key), so it starts calm.
		await expect(card.getByText("Needs setup", { exact: true })).toHaveCount(0);

		// Clear the partition key — the schema requires one. Readiness is derived from the EXACT
		// validation the deploy uses, so the card must flip immediately, with no round-trip.
		await page.getByLabel("Partition key").fill("");

		await expect(card.getByText("Needs setup", { exact: true })).toBeVisible();
	});

	test("secrets collapse into ONE vault card, not one card each", async ({
		page,
	}) => {
		await addService(page, "Secret");
		await addService(page, "Secret");
		await addService(page, "Secret");

		// Three secrets → exactly one card on the board, showing the count. THIS is the whole point:
		// a real project has 30–40 of these.
		const vault = board(page).locator(".react-flow__node-collection");
		await expect(vault).toHaveCount(1);
		await expect(vault.getByText("3", { exact: true })).toBeVisible();
		await expect(vault.getByText("secrets", { exact: true })).toBeVisible();

		// And no individual secret card is drawn.
		await expect(board(page).locator(".react-flow__node-secret")).toHaveCount(0);
	});

	test("the vault opens to a list where each secret is still individually configurable", async ({
		page,
	}) => {
		await addService(page, "Secret");
		await addService(page, "Secret");

		await board(page).locator(".react-flow__node-collection").click();

		// Forty rows need a filter, or the list is exactly as unusable as forty cards were.
		await expect(page.getByPlaceholder(/filter secrets/i)).toBeVisible();

		// Clicking a row opens that single secret's own inspector — collapsing the view never takes
		// away the ability to configure ONE.
		await page.getByRole("button", { name: /^secret/ }).first().click();
		await expect(page.getByText("Auto-generate value")).toBeVisible();

		// …and there's a route back up to the vault, so you're never stranded.
		await expect(page.getByRole("button", { name: "Secrets" })).toBeVisible();
	});

	test("the board draws the VPC and cluster regions", async ({ page }) => {
		// A new project already ships a network and a cluster (they're singletons — the palette
		// disables them once present), so the regions are there from the start.

		// Two nested regions: the VPC, and the cluster inside it.
		await expect(board(page).locator(".react-flow__node-zone")).toHaveCount(2);
		await expect(board(page).getByText("VPC", { exact: true })).toBeVisible();
		await expect(
			board(page).getByText("Cluster", { exact: true }).first(),
		).toBeVisible();
	});

	test("a region is a real container — drag it and its members follow; resize it and they don't", async ({
		page,
	}) => {
		const boardEl = board(page);
		// The VPC region carries the "VPC" label in its header.
		const vpc = boardEl.locator(".react-flow__node-zone", { hasText: "VPC" });
		await expect(vpc).toBeVisible();
		// The cluster card is a member that sits inside the VPC — track it through the interactions.
		const clusterCard = boardEl.locator(".react-flow__node-cluster");
		await expect(clusterCard).toBeVisible();

		// ── Drag the VPC by its HEADER (the only drag handle) → its members move with it. ──
		const header = vpc.locator(".zone-drag-handle");
		const hb = (await header.boundingBox())!;
		const before = (await clusterCard.boundingBox())!;
		await page.mouse.move(hb.x + 24, hb.y + hb.height / 2);
		await page.mouse.down();
		await page.mouse.move(hb.x + 24 + 130, hb.y + hb.height / 2 + 70, { steps: 10 });
		await page.mouse.up();

		const afterDrag = (await clusterCard.boundingBox())!;
		// The member tracked the drag (screen-space delta ≈ the drag, independent of zoom).
		expect(Math.abs(afterDrag.x - before.x - 130)).toBeLessThan(45);
		expect(Math.abs(afterDrag.y - before.y - 70)).toBeLessThan(45);

		// ── Selecting the region reveals its resize handles. ──
		await header.click();
		const handle = page.locator(".react-flow__resize-control.handle").first();
		await expect(handle).toBeVisible();

		// ── Resizing must NOT move the members. ──
		const beforeResize = (await clusterCard.boundingBox())!;
		const grip = (await handle.boundingBox())!;
		await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
		await page.mouse.down();
		await page.mouse.move(grip.x + 90, grip.y + 90, { steps: 8 });
		await page.mouse.up();

		const afterResize = (await clusterCard.boundingBox())!;
		expect(Math.abs(afterResize.x - beforeResize.x)).toBeLessThan(6);
		expect(Math.abs(afterResize.y - beforeResize.y)).toBeLessThan(6);

		// ── A dragged/resized region offers a re-fit control that returns it to auto-fit. ──
		await expect(vpc.getByRole("button", { name: /re-fit/i })).toBeVisible();
	});

	test("a topic's subscriptions are definable at all (the column had no editor)", async ({
		page,
	}) => {
		await addService(page, "Topic");

		// Adding a node opens its inspector. `subscriptions` is a TopicSubscription[] column that has
		// existed since the baseline migration with NO editor — you could name a topic and nothing else.
		await page.getByRole("button", { name: /add a subscription/i }).click();

		// A row appears carrying the fields the column actually holds.
		await expect(page.getByLabel("Endpoint")).toBeVisible();
		await expect(page.getByLabel("Protocol")).toBeVisible();
	});

	test("the cluster can be sized portably (vCPU / memory), not just by a cloud SKU", async ({
		page,
	}) => {
		// The cluster is a singleton and a new project already has one — open it rather than adding.
		await board(page).locator(".react-flow__node-cluster").click();

		// node_size is the cloud-INDIFFERENT sizing the Go resolver maps to a per-cloud instance type.
		// The panel never exposed it, so the only way to size a cluster was to pick a concrete SKU.
		await expect(page.getByText("vCPU per node")).toBeVisible();
		await expect(page.getByText(/Memory per node/)).toBeVisible();
	});
});
