// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// End-to-end proof of the Architecture canvas, driven through the real app: the per-service fact
// cards, the Secrets vault (a project with 30–40 secrets must not be 30–40 cards), the definition
// panel's newly-definable fields — and, since the canvas-polish wave, the WORKSPACE RAIL: every
// "open on the right" is a non-blocking docked card, so a card and the board are usable at the
// same time.
//
// Hermetic: reuses the shared OTP-signed-up persona (the `setup` project) and designs on the canvas
// WITHOUT connecting a cloud account — "Create empty project" needs only a name, and the palette
// explicitly supports designing before a cloud is connected. No external services. That also fixes
// the ceiling of this file: with no cloud identity `projectFormSchema` refuses (`cloud_identity_id`
// is required), so nothing here can Save or Deploy — every assertion is about the board, the rail
// and the client draft.
//
// Assertions are scoped to the BOARD (`.react-flow`) or the RAIL (`[data-testid=workspace-rail]`),
// never the whole page: the same words legitimately appear in both (a bucket's "Access" fact and
// the card's "Access" section), and an unscoped query can't tell them apart.

import { test, expect, type Page } from "@playwright/test";

test.describe("Architecture canvas", () => {
	// Runs on the `canvas` project: ONE shared persona from the `setup` project, not a signup per
	// test — a handful of hermetic signups in a row trips Better Auth's per-IP rate limit (the same
	// reason the Elench specs share one). The budget covers `next dev` compiling on first hit.
	test.setTimeout(180_000);

	/** The board itself — everything drawn on the canvas. */
	const board = (page: Page) => page.locator(".react-flow");

	/** The workspace rail — the ONE docked card surface every "open on the right" renders into. */
	const rail = (page: Page) => page.getByTestId("workspace-rail");

	/** Every card currently drawn on the board (React Flow renders one element per card). */
	const cards = (page: Page) => board(page).locator(".react-flow__node");

	test.beforeEach(async ({ page }, testInfo) => {
		// The stored session lands on the org; read the slug off the URL rather than signing up again.
		await page.goto("/");
		await page.waitForURL((url) => /^\/[^/]+/.test(url.pathname), { timeout: 60_000 });
		const orgSlug = new URL(page.url()).pathname.replace(/^\//, "").replace(/\/.*$/, "");
		expect(orgSlug, "resolved an org slug from the stored session").toBeTruthy();

		// The two-step create flow: on `~/new` the "Blank project" card routes to Configure, which needs
		// only a NAME (no cloud identity) — keeping this hermetic. A unique name per test gives each its
		// own project, so they stay independent. Creating lands on `/{org}/{project}/architecture`, i.e.
		// the canvas in EDIT mode (a real project + environment), which is what the toolbar's Run menu,
		// the cost chip and the Activity card are gated on.
		await page.goto(`/${orgSlug}/~/new`);
		await page.getByRole("button", { name: /blank project/i }).click();
		await page
			.locator("#project_name")
			.fill(`canvas-e2e-${testInfo.workerIndex}-${Date.now()}`);
		await page.getByRole("button", { name: /create project/i }).click();

		// The canvas is ready once its toolbar is painted. (The Add button is always present on an
		// editable, non-IaC-governed board; the old "Project settings" cog this used to key on was
		// removed in #554. The toolbar is now `[cost, when priced] [Run ▾] [Add] [⋯]` — Add is the
		// one control that is there on a fresh, unpriced environment, so it stays the ready signal.)
		await expect(
			page.getByRole("button", { name: "Add", exact: true }).first(),
		).toBeVisible({ timeout: 60_000 });
	});

	/** Open the Add palette and drop a service (only kinds with no variant step). */
	async function addService(page: Page, name: string) {
		// The palette's Add button lives on the board's toolbar; list fields in the card also have an
		// "Add", so scope to the toolbar's exact one.
		await page.getByRole("button", { name: "Add", exact: true }).first().click();
		const search = page.getByPlaceholder(/search services/i);
		await expect(search).toBeVisible();
		await search.fill(name);
		await page.getByRole("option", { name: new RegExp(name, "i") }).first().click();
		await expect(search).toBeHidden();
	}

	/** Open the board's ⋯ menu and choose one of its items. */
	async function moreMenu(page: Page, item: string | RegExp) {
		await page.getByRole("button", { name: "More", exact: true }).click();
		await page.getByRole("menuitem", { name: item }).click();
	}

	test("a service card shows the facts that matter for THAT service", async ({
		page,
	}) => {
		await addService(page, "Bucket");

		// The bucket's fact grid — access · versioning · CORS. This is what makes a bucket read
		// differently from a database on a canvas that has no colour to spend.
		// Target the bucket's OWN card: `.first()` would assert against whatever else is on the board.
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

		// Clicking a row opens that single secret's own card — collapsing the view never takes
		// away the ability to configure ONE.
		await page.getByRole("button", { name: /^secret/ }).first().click();
		await expect(page.getByText("Auto-generate value")).toBeVisible();

		// …and there's a route back up to the vault, so you're never stranded.
		await expect(page.getByRole("button", { name: "Secrets" })).toBeVisible();
	});

	test("a topic's subscriptions are definable at all (the column had no editor)", async ({
		page,
	}) => {
		await addService(page, "Topic");

		// Adding a node opens its card. `subscriptions` is a TopicSubscription[] column that has
		// existed since the baseline migration with NO editor — you could name a topic and nothing else.
		await page.getByRole("button", { name: /add a subscription/i }).click();

		// A row appears carrying the fields the column actually holds.
		await expect(page.getByLabel("Endpoint")).toBeVisible();
		await expect(page.getByLabel("Protocol")).toBeVisible();
	});

	// ── The workspace rail ────────────────────────────────────────────────────────────────────────
	//
	// The wave's central claim: nothing on this page opens a modal over the board any more. Every
	// card is an in-flow flex child of `[data-testid=workspace-rail]`, so "a card is open" and "the
	// board is usable" stopped being mutually exclusive. `[data-slot=sheet-overlay]` is the negative
	// form of that claim — a Sheet's overlay is what used to swallow the board's clicks — and it is
	// asserted directly rather than inferred from the rail's presence.

	test("a card and the Add palette are open at once — the rail docks, it does not block", async ({
		page,
	}) => {
		await addService(page, "Bucket");

		// Click the bucket: its card is on the rail, and the rail says so structurally.
		await board(page).locator(".react-flow__node-bucket").click();
		await expect(rail(page)).toHaveAttribute("data-open", "true");
		await expect(rail(page).getByPlaceholder("name", { exact: true })).toBeVisible();

		// …and now add a SECOND service without closing it. Before the rail this was impossible:
		// the palette and the panel fought for the same screen and the panel lost.
		await addService(page, "Queue");

		// Both cards are on the board and both are reachable — clicking either switches the rail to
		// it, which is the proof the board never stopped taking clicks.
		await expect(board(page).locator(".react-flow__node-bucket")).toBeVisible();
		await expect(board(page).locator(".react-flow__node-queue")).toBeVisible();
		await board(page).locator(".react-flow__node-bucket").click();
		await expect(rail(page)).toHaveAttribute("data-open", "true");

		// Nothing modal opened at any point. This is the assertion the whole rail exists for.
		await expect(page.locator("[data-slot=sheet-overlay]")).toHaveCount(0);
	});

	test("⋯ → Environment settings docks on the rail, and the board behind it stays live", async ({
		page,
	}) => {
		await addService(page, "Bucket");

		await moreMenu(page, "Environment settings");

		// The cluster and the VPC are no longer cards on the board (W2 — one environment IS one
		// cluster inside one VPC); they are edited here. `node_size` is the cloud-INDIFFERENT sizing
		// the Go resolver maps to a per-cloud instance type, and it lives on this card now.
		await expect(rail(page)).toHaveAttribute("data-open", "true");
		await expect(
			rail(page).getByRole("heading", { name: "Environment settings" }),
		).toBeVisible();
		await expect(rail(page).getByText("vCPU per node")).toBeVisible();
		await expect(rail(page).getByText(/Memory per node/)).toBeVisible();
		await expect(page.locator("[data-slot=sheet-overlay]")).toHaveCount(0);

		// The board behind the card is still a board: clicking a node swaps the rail to that node's
		// card. A modal Sheet would have eaten this click.
		await board(page).locator(".react-flow__node-bucket").click();
		await expect(rail(page).getByPlaceholder("name", { exact: true })).toBeVisible();
		await expect(
			rail(page).getByRole("heading", { name: "Environment settings" }),
		).toHaveCount(0);
	});

	test("right-click a card → Remove takes it off the board, and ⌘Z puts it back", async ({
		page,
	}) => {
		await addService(page, "Bucket");
		const bucket = board(page).locator(".react-flow__node-bucket");
		await expect(bucket).toHaveCount(1);
		const before = await cards(page).count();

		// Right-click did nothing on this board before the wave — and the board is where right-DRAG
		// pans, so the gesture read as broken rather than absent.
		await bucket.click({ button: "right" });
		await expect(page.getByRole("menuitem", { name: "Configure" })).toBeVisible();
		await page.getByRole("menuitem", { name: "Remove" }).click();

		await expect(bucket).toHaveCount(0);
		await expect(cards(page)).toHaveCount(before - 1);

		// Remove goes through the store's `removeNodes`, which commits an undo step — that is the
		// whole reason the context menu doesn't delete nodes itself.
		await page.keyboard.press("ControlOrMeta+z");
		await expect(bucket).toHaveCount(1);
		await expect(cards(page)).toHaveCount(before);
	});

	test('a fresh environment says nothing about cost rather than "Not priced"', async ({
		page,
	}) => {
		await addService(page, "Bucket");
		// Close the card the add opened. The card's Cost tab legitimately says "not priced yet" —
		// that is where the question is actually asked — so leaving it open would make this assertion
		// about which tab base-ui happens to have mounted rather than about the toolbar.
		await rail(page).getByRole("button", { name: "Close" }).click();
		await expect(rail(page)).toHaveAttribute("data-open", "false");

		// The cost chip renders NOTHING when the environment has never been priced. A dashed "Not
		// priced" pill in the toolbar of every fresh environment is a label for an absence, on the
		// one row that is meant to ease a first visit in — and a fabricated $0.00 would be worse,
		// because you would believe it.
		await expect(page.getByText(/not priced/i)).toHaveCount(0);
	});

	test("⋯ → Activity is honest about an environment that has never run anything", async ({
		page,
	}) => {
		// The status line over the board renders nothing until something has run — an environment
		// with no history gets no chrome claiming otherwise.
		await expect(page.getByLabel("Open the activity log")).toHaveCount(0);

		await moreMenu(page, "Activity");

		await expect(rail(page)).toHaveAttribute("data-open", "true");
		await expect(rail(page).getByText("Nothing has run here yet")).toBeVisible();
		// The paging control belongs to a list with a next page; an empty environment has neither.
		await expect(rail(page).getByRole("button", { name: "Show more" })).toHaveCount(0);
		await expect(page.locator("[data-slot=sheet-overlay]")).toHaveCount(0);
	});

	// ⚠ RED UNTIL #4255 LANDS, and deliberately left un-annotated so it reads as the gap it is.
	// `design-project-workbench.tsx` still calls `setGraph` on every mount when a `sourceProject`
	// is present, which replaces the graph and closes the card — so a reload discards the draft.
	// #4255 keys that effect on the design REVISION and routes it through the store's `reseed`
	// (same scope + same revision → no-op), which is what makes this pass. Note the rail itself is
	// legitimately closed after a reload: `card` is view state and is deliberately NOT persisted
	// ("a card is a view, not a draft"), so what survives a full reload is the EDIT; the open card
	// surviving an identical-content RE-RENDER is #4255's `workbench-seed.test.tsx`.
	test("an edit typed into a card survives a reload — the draft is the autosave", async ({
		page,
	}) => {
		await addService(page, "Bucket");
		const nameField = rail(page).getByPlaceholder("name", { exact: true });
		await expect(nameField).toBeVisible();

		// A distinctive, schema-legal name (the field lowercases what you type).
		const renamed = `e2e-renamed-${Date.now()}`;
		await nameField.fill(renamed);
		// Blur: the card's buffer commits to the store on blur, and the store's `persist` writes the
		// per-environment sessionStorage draft. There is no server autosave — the live design tables
		// are shared across sessions, so the draft IS the autosave.
		await nameField.blur();
		await expect(board(page).getByText(renamed)).toBeVisible();

		await page.reload();

		// The board comes back carrying the unsaved edit, and it is still staged: the pending-changes
		// bar diffs the draft against the baseline the server seeded, so the change is not silently
		// adopted as deployed truth either.
		await expect(
			board(page).getByText(renamed),
			"the unsaved rename survived the reload",
		).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("Pending changes")).toBeVisible();

		// And re-opening the card shows the edit, not the server's name.
		await board(page).locator(".react-flow__node-bucket").click();
		await expect(rail(page).getByPlaceholder("name", { exact: true })).toHaveValue(
			renamed,
		);
	});
});
