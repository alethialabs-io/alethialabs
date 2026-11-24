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
// is required), so nothing here can Plan or Deploy — and no journey but the one below presses Save,
// which since #7272 DOES work without a cloud account (`designSaveSchema`). Every other assertion is
// about the board, the rail and the client draft.
//
// Assertions are scoped to the BOARD (`.react-flow`) or the RAIL (`[data-testid=workspace-rail]`),
// never the whole page: the same words legitimately appear in both (a bucket's "Access" fact and
// the card's "Access" section), and an unscoped query can't tell them apart.
//
// ── THE DEPLOY BOUNDARY IS A CONTROL NOW, NOT A SENTENCE ──────────────────────────────────────
//
// The paragraph above used to be the whole of it: "nothing here can Save or Deploy" was a claim
// about a fixture, restated in prose, and a journey added later that clicks one button too many
// would have broken it silently — on real infrastructure, on someone else's account. Two things
// enforce it now, and `e2e/helpers/deploy-guard.ts` states exactly what each one can prove:
//
//   · `deployControl()` hands back a locator whose click / press / tap THROW. Deploy is in the
//     review view, not on the bar (#6833), and on this fixture it is DISABLED: this project has no
//     cloud identity, so the design has issues and no plan can be run for it. A disabled button
//     issues no request, so a network-only guard is vacuous against the very click it is named
//     after — which is why the control itself is wrapped.
//   · the `afterEach` below fails any test whose page put the board's DESIGN on the wire. It keys
//     on the payload rather than on "a POST happened", because a Next server action's name is
//     nowhere in its request and the Activity card on this route reads through one.
//
// Neither reaches the Run menu's four job actions, which queue real work through small-bodied
// server actions. Those are opened and never clicked, and that one remains a convention — stated
// here rather than left to be assumed.
//
// ── THE ONE WRITE ─────────────────────────────────────────────────────────────────────────────
//
// "Save clears the bar and a reload shows no pending changes" is the single journey here that puts
// the design on the wire. It seeds its own project with a connected (fixture) cloud account and a
// region, straight into the database, and saves THAT — it predates #7272, when a save with no cloud
// identity was refused in the browser, and a per-test project keeps its write off the shared
// fixture either way. A save writes the design tables and queues nothing, so it costs nothing. The test raises
// `designWritesAllowed` to exactly 1 for itself, and the `afterEach` holds every test to its own
// number — zero for all the others — so the exception is counted rather than waved through.

import { test, expect, type Locator, type Page } from "@playwright/test";
import { resolveOwner } from "./audit/context";
import { requireAxe, scanA11y } from "./helpers/a11y";
import {
	breachMessage,
	neverActivated,
	watchPage,
	type DesignPayloadWatch,
} from "./helpers/deploy-guard";
import { seedCloudIdentity, seedProject } from "./helpers/seed";

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

	/**
	 * A card, by the name it carries — `"<kind> <name>"`, or the kind alone before it is named.
	 *
	 * This is the handle `.react-flow__node-<kind>` could never be: that class is React Flow's
	 * renderer, not the product, and it cannot tell one bucket from another.
	 */
	const card = (page: Page, name: string | RegExp) =>
		board(page).getByRole("group", { name });

	/**
	 * The changeset bar while changes are pending — Discard, Save and Review plan live on it. It has
	 * no Deploy. (On a clean board the same bar is `changeset-bar`, which is why a discarded or saved
	 * draft has no element by this id.)
	 */
	const pendingBar = (page: Page) => page.getByTestId("pending-changes-bar");

	/** The review-and-deploy view, opened from the bar's Review plan. The only place Deploy is. */
	const reviewView = (page: Page) => page.getByTestId("review-view");

	/**
	 * The Deploy button, wrapped so that activating it throws.
	 *
	 * Every reference to Deploy in this file goes through here. The control is still located and
	 * still asserted on — its presence and its label are the evidence that the boundary exists —
	 * it simply cannot fire.
	 */
	const deployControl = (page: Page): Locator =>
		neverActivated(
			reviewView(page).getByRole("button", { name: "Deploy", exact: true }),
			"Deploy",
		);

	/**
	 * The request watch for the test in flight.
	 *
	 * A plain `let` is enough: Playwright runs one test at a time per worker and re-imports this
	 * file per worker, so two tests can never share it.
	 */
	let boundary: DesignPayloadWatch | null = null;

	/**
	 * How many requests carrying the design the test in flight is entitled to make. Zero, reset
	 * before every test; the one journey that saves raises it to exactly 1 for itself.
	 */
	let designWritesAllowed = 0;

	test.beforeEach(async ({ page }, testInfo) => {
		designWritesAllowed = 0;
		// The stored session lands on the org; read the slug off the URL rather than signing up again.
		await page.goto("/");
		await page.waitForURL((url) => /^\/[^/]+/.test(url.pathname), { timeout: 60_000 });
		const orgSlug = new URL(page.url()).pathname.replace(/^\//, "").replace(/\/.*$/, "");
		expect(orgSlug, "resolved an org slug from the stored session").toBeTruthy();

		// The one-screen create, opened on the "Blank" starting point, which needs only a NAME (no
		// cloud identity) — keeping this hermetic. A unique name per test gives each its own project,
		// so they stay independent. Creating lands on `/{org}/{project}/architecture`, i.e. the canvas
		// in EDIT mode (a real project + environment), which is what the toolbar's Run menu, the cost
		// chip and the Activity card are gated on.
		await page.goto(`/${orgSlug}/~/new?source=blank`);
		await page
			.locator("#project_name")
			.fill(`canvas-e2e-${testInfo.workerIndex}-${Date.now()}`);
		await page.getByRole("button", { name: /create project/i }).click();

		// The canvas is ready once its toolbar is painted. The toolbar is one row, top-centre (#6832):
		// `[environment] [Select | Hand] [Add | Connect] [Undo | Redo] [Tidy | Fit] [Run | Sources]
		// [⌘K | ? | More]`. Add is on every editable, non-IaC-governed board, fresh or not, so it is
		// the ready signal. (The guide on an empty board has its own "Add a component", which the
		// exact name does not match.)
		await expect(
			page.getByRole("button", { name: "Add", exact: true }).first(),
		).toBeVisible({ timeout: 60_000 });

		// ARMED HERE, not earlier: creating the project legitimately posts the project form to
		// `~/new`, and that request is this fixture's setup, not a finding.
		boundary = watchPage(page);
	});

	test.afterEach(() => {
		const crossed = boundary?.stop() ?? [];
		boundary = null;
		expect(
			crossed,
			designWritesAllowed === 0
				? breachMessage(crossed)
				: `expected exactly ${designWritesAllowed} request(s) carrying the design, saw ${crossed.length}`,
		).toHaveLength(designWritesAllowed);
	});

	/**
	 * Open the Add palette and drop a service (only kinds with no variant step).
	 *
	 * The two assertions after the pick are the contract of #4589, and they are two rather than one
	 * for a measured reason. `toBeHidden()` on the search box alone was satisfied by a STEP CHANGE:
	 * the palette used to swap to an inline "Configure service" view, which has no search input, so
	 * this helper returned while the dialog was still mounted and its overlay intercepted every later
	 * click on the board — six tests in this file timing out at their full 180s budget rather than
	 * failing on an assertion. The dialog OVERLAY is the thing that actually swallowed the clicks, so
	 * it is what is asserted, in the same negative form `[data-slot=sheet-overlay]` is asserted below.
	 * The rail assertion is the positive half: picking a service is what opens that node's card.
	 */
	async function addService(page: Page, name: string) {
		// The palette's Add button lives on the board's toolbar; list fields in the card also have an
		// "Add", so scope to the toolbar's exact one.
		await page.getByRole("button", { name: "Add", exact: true }).first().click();
		const search = page.getByPlaceholder(/search services/i);
		await expect(search).toBeVisible();
		await search.fill(name);
		await page.getByRole("option", { name: new RegExp(name, "i") }).first().click();
		await expect(search).toBeHidden();
		await expect(page.locator("[data-slot=dialog-overlay]")).toHaveCount(0);
		await expect(rail(page)).toHaveAttribute("data-open", "true");
	}

	/**
	 * Open one of the inspector's Settings groups by its title.
	 *
	 * On first view only a group holding a field the schema rejects is open (#6837), so a fresh,
	 * valid node shows every group collapsed behind its value summary. The trigger is clicked only
	 * when it reports `aria-expanded="false"`: a blind click would CLOSE a group that is already
	 * open, and the test would then fail on a field it had just hidden.
	 */
	async function openGroup(page: Page, title: string) {
		const trigger = rail(page).getByRole("button", { name: new RegExp(`^${title}`) }).first();
		await expect(trigger).toBeVisible();
		if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
		await expect(trigger).toHaveAttribute("aria-expanded", "true");
	}

	/** Open the board's ⋯ menu and choose one of its items. */
	async function moreMenu(page: Page, item: string | RegExp) {
		await page.getByRole("button", { name: "More", exact: true }).click();
		await page.getByRole("menuitem", { name: item }).click();
	}

	/** Close the inspector, so the board has its full width and no field holds the focus. */
	async function closeInspector(page: Page) {
		await rail(page).getByRole("button", { name: "Close" }).click();
		await expect(rail(page)).toHaveAttribute("data-open", "false");
	}

	/** A connection drawn on the board, by the name it carries: "Connection from <card> to <card>". */
	const connection = (page: Page, name: RegExp) => board(page).getByRole("group", { name });

	/**
	 * Give a card or a connection the focus the way the keyboard does.
	 *
	 * The board makes a keyboard focus stop the selection (so arrows move it and Delete removes it)
	 * but leaves a focus that came from a press alone. It tells the two apart by the last input on
	 * the board, or by `:focus-visible`. A bare `locator.focus()` after a pointer gesture reads as a
	 * press, so a key is pressed on the board first: Shift, which nothing on the board binds.
	 */
	async function keyboardFocus(page: Page, target: Locator) {
		await target.focus();
		await page.keyboard.press("Shift");
		await target.blur();
		await target.focus();
	}

	/**
	 * The centre of an element, once a pointer there would actually hit it (it, or something inside
	 * it) rather than whatever is drawn over it. The box is re-read on every try, so a layout that is
	 * still settling is waited out rather than measured mid-move.
	 */
	async function hittableCentre(target: Locator): Promise<{ x: number; y: number }> {
		let centre = { x: 0, y: 0 };
		await expect
			.poll(async () => {
				const box = await target.boundingBox();
				if (!box) return false;
				centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
				return target.evaluate((el, p) => {
					const top = document.elementFromPoint(p.x, p.y);
					return top !== null && (top === el || el.contains(top));
				}, centre);
			})
			.toBe(true);
		return centre;
	}

	/**
	 * Drag a connection from a service card's bottom handle and release it over another card.
	 *
	 * Both ends are hit-tested first. A press on a covered handle moves whatever covers it, and the
	 * journey would then fail on a missing line, far from the cause.
	 */
	async function dragConnection(page: Page, from: Locator, to: Locator) {
		const handle = from.locator(".react-flow__handle-bottom");
		await expect(handle).toBeInViewport();
		await expect(to).toBeInViewport();
		const press = await hittableCentre(handle);
		const release = await hittableCentre(to);
		await page.mouse.move(press.x, press.y);
		await page.mouse.down();
		await page.mouse.move(release.x, release.y, { steps: 15 });
		await page.mouse.up();
	}

	/** The guide an empty board shows in place of cards. */
	const guide = (page: Page) => page.locator("[data-slot=board-guide]");

	/** Open this test's board again with `?seed=<wire>` in its URL. */
	async function openWithSeed(page: Page, wire: string) {
		const url = new URL(page.url());
		url.searchParams.set("seed", wire);
		await page.goto(url.toString());
		await expect(
			page.getByRole("button", { name: "Add", exact: true }).first(),
		).toBeVisible({ timeout: 60_000 });
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
		//
		// `fill("")` types without blurring, and that is the point rather than an accident of the API:
		// the card's editing buffer (#4256) holds keystrokes back from the store, readiness reads the
		// store, and for a while that let a card go on saying "deployable" while holding a value the
		// deploy would reject (#4445). The buffer may defer the WRITE; it may not defer the truth, so
		// a text edit that flips the field between valid and invalid commits with it.
		await openGroup(page, "Schema");
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
		await openGroup(page, "General");
		await expect(page.getByText("Auto-generate value")).toBeVisible();

		// …and there's a route back up to the vault, so you're never stranded.
		await expect(page.getByRole("button", { name: "Secrets" })).toBeVisible();
	});

	test("a topic's subscriptions are definable at all (the column had no editor)", async ({
		page,
	}) => {
		await addService(page, "Topic");

		// Adding a node opens its card — on the RAIL, on the tab that holds its config, which is what
		// the Add palette's inline "Configure service" step used to be (#4589). `subscriptions` is a
		// TopicSubscription[] column that has existed since the baseline migration with NO editor —
		// you could name a topic and nothing else.
		await openGroup(page, "Subscriptions");
		await rail(page).getByRole("button", { name: /add a subscription/i }).click();

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
	//
	// The ADD flow was the last thing that made the claim untrue (#4589): the palette is a
	// `CommandDialog`, and it used to stay open on an inline config step after a pick, so every test
	// below was clicking through a live modal. It now closes on the pick and the node's card opens on
	// the rail instead — `addService` asserts both halves, which is why these tests can click at all.

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
		await openGroup(page, "Node sizing");
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

	// The workbench seeds the board once per design REVISION (#4255), and a seed for the same scope
	// and the same revision leaves the draft alone, which is what lets the edit below survive. The
	// rail is legitimately closed after a reload: what the inspector follows is view state and is
	// deliberately NOT persisted ("a card is a view, not a draft"), so what survives a full reload is
	// the EDIT; the open inspector surviving an identical-content RE-RENDER is pinned by
	// `workbench-seed.test.tsx`.
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
	// ── journeys ──────────────────────────────────────────────────────────────────────────────────
	//
	// Each of these is one thing a person actually does on this board, driven end to end. They share
	// the fixture above — one fresh project per test — so none of them can see another's nodes.

	test("Deploy is not on the bar: it is in the review view, disabled with its reason, and this spec CANNOT press it", async ({
		page,
	}) => {
		// Staging one change is what puts the bar in its pending state.
		await addService(page, "Bucket");
		await expect(pendingBar(page)).toBeVisible();

		// The bar does not deploy. Its one way forward is the review.
		await expect(pendingBar(page).getByRole("button", { name: "Deploy", exact: true })).toHaveCount(0);
		await pendingBar(page).getByRole("button", { name: "Review plan", exact: true }).click();
		await expect(reviewView(page)).toBeVisible();

		// The boundary exists and is reachable — that is the half worth asserting. A Deploy button
		// that had quietly stopped rendering would make every "never clicked" claim in this file
		// true and worthless. Here it is present and DISABLED, and the view says why: this project
		// has no cloud account, so the design has issues, and there is no reviewed plan to deploy.
		const raw = reviewView(page).getByRole("button", { name: "Deploy", exact: true });
		await expect(raw).toBeVisible();
		await expect(raw).toBeDisabled();
		const reason = reviewView(page).getByTestId("deploy-reason");
		await expect(reason).toHaveAttribute("data-block", "issues");
		await expect(reason).toContainText(/issue/);

		// …and the guarded handle this file uses everywhere refuses to fire. This is the POSITIVE
		// CONTROL: it proves, inside the real run, that the guard is wired rather than merely
		// present. `e2e/helpers/deploy-guard.ts` has the same proof per-verb without a browser.
		let refusal: string | null = null;
		try {
			await deployControl(page).click({ timeout: 1_000 });
		} catch (e) {
			refusal = e instanceof Error ? e.message : String(e);
		}
		expect(
			refusal,
			"the guarded Deploy locator must refuse to be activated — if this is null the boundary is decorative",
		).toContain("must NEVER be activated");
	});

	test("a card is a NAMED region — two buckets are told apart by name, not by a CSS class", async ({
		page,
	}) => {
		await addService(page, "Bucket");
		const first = rail(page).getByPlaceholder("name", { exact: true });
		await first.fill("assets");
		await first.blur();

		await addService(page, "Bucket");
		const second = rail(page).getByPlaceholder("name", { exact: true });
		await second.fill("uploads");
		await second.blur();

		// THE ATTRIBUTE AS WELL AS THE NAME. An accessible name can come from a `title` — these cards
		// carry one on their status badge — so a role-only query can pass on a tree that lost its
		// `aria-label` entirely. Asserting the attribute is what makes this a test of the label.
		await expect(card(page, "Bucket assets")).toHaveAttribute("aria-label", "Bucket assets");
		await expect(card(page, "Bucket uploads")).toHaveAttribute("aria-label", "Bucket uploads");
	});

	test("⌘K → Add Bucket puts a card on the board and leaves no modal behind", async ({
		page,
	}) => {
		await page.keyboard.press("ControlOrMeta+k");
		const search = page.getByPlaceholder(/search services and actions/i);
		await expect(search).toBeVisible();
		await search.fill("Bucket");
		await page.getByRole("option", { name: /add bucket/i }).first().click();

		// Same two-part contract as the Add palette (#4589): the command menu CLOSES, and its overlay
		// goes with it. A step change that merely hides the search box is what left six tests in this
		// file clicking through a live modal.
		await expect(search).toBeHidden();
		await expect(page.locator("[data-slot=dialog-overlay]")).toHaveCount(0);
		await expect(card(page, /^Bucket/)).toHaveCount(1);
	});

	test("⌘Z undoes an add and ⌘⇧Z puts it back", async ({ page }) => {
		await addService(page, "Bucket");
		await expect(card(page, /^Bucket/)).toHaveCount(1);

		// ⌘Z is the board's undo only while the focus is NOT in a field: in a field the chord is the
		// field's own (`canvas.undo` in `toolbar/canvas-keys.ts` does not set `allowInInput`). So the
		// press below reaches the board only because an add leaves the focus outside the card's name
		// field. That precondition is asserted rather than assumed: if an add ever starts putting the
		// caret in the name field, this fails here, naming the cause, and not on the count below.
		await expect(rail(page).getByPlaceholder("name", { exact: true })).not.toBeFocused();
		await page.keyboard.press("ControlOrMeta+z");
		await expect(card(page, /^Bucket/)).toHaveCount(0);

		await page.keyboard.press("ControlOrMeta+Shift+z");
		await expect(card(page, /^Bucket/)).toHaveCount(1);
	});

	test("⌘D duplicates the selected resource", async ({ page }) => {
		await addService(page, "Bucket");
		// Selection is what ⌘D operates on; clicking the card is how you make one.
		await card(page, /^Bucket/).first().click();
		await page.keyboard.press("ControlOrMeta+d");

		await expect(card(page, /^Bucket/)).toHaveCount(2);
	});

	test("the card's danger zone deletes the resource, and ⌘Z brings it back", async ({
		page,
	}) => {
		// `canvas.delete-resource` in apps/console/destructive-actions.yaml, whose recorded
		// confirmation is `undo` rather than a dialog: the cost of the mistake is one keystroke, and
		// a dialog on every resource delete would train people to dismiss dialogs. This test is what
		// makes the undo half of that ruling true rather than asserted.
		await addService(page, "Bucket");
		await rail(page).getByRole("tab", { name: "Settings" }).click();
		await rail(page).getByRole("button", { name: /danger zone/i }).click();
		await rail(page).getByRole("button", { name: "Delete", exact: true }).click();

		await expect(card(page, /^Bucket/)).toHaveCount(0);

		await page.keyboard.press("ControlOrMeta+z");
		await expect(card(page, /^Bucket/)).toHaveCount(1);
	});

	test("Discard asks first: Cancel keeps the staged changes, Discard clears them", async ({
		page,
	}) => {
		await addService(page, "Bucket");
		await expect(pendingBar(page)).toBeVisible();

		await pendingBar(page).getByRole("button", { name: "Discard", exact: true }).click();
		const confirm = page.getByRole("alertdialog");
		await expect(confirm.getByText("Discard staged changes?")).toBeVisible();

		// Cancel is not a no-op to assert: a confirmation that discards anyway is the exact defect
		// `e2e/audit/destructive.spec.ts` exists to catch, and it is invisible from the dialog alone.
		await confirm.getByRole("button", { name: "Cancel" }).click();
		await expect(confirm).toHaveCount(0);
		await expect(pendingBar(page)).toBeVisible();
		await expect(card(page, /^Bucket/)).toHaveCount(1);

		await pendingBar(page).getByRole("button", { name: "Discard", exact: true }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Discard", exact: true }).click();

		// The bar diffs the draft against the server's baseline, so an emptied draft has no bar.
		await expect(pendingBar(page)).toHaveCount(0);
		await expect(card(page, /^Bucket/)).toHaveCount(0);
	});

	test("⋯ → Environment settings offers Destroy environment — and Cancel is all this spec presses", async ({
		page,
	}) => {
		// The environment's settings card is where it is destroyed. This used to live on the project
		// node's inspector, and the project node is not rendered on the board (canvas-flow.tsx filters
		// it), so the control was unreachable — the defect #4775 fixed.
		await moreMenu(page, "Environment settings");
		await rail(page).getByRole("button", { name: "Destroy", exact: true }).click();

		const confirm = page.getByRole("alertdialog");
		await expect(confirm.getByText("Destroy this environment?")).toBeVisible();
		// The confirm is located so it can be ASSERTED — its presence and its label are the evidence
		// that `env.destroy` is gated — and wrapped so that this spec cannot fire it.
		const destroy = neverActivated(
			confirm.getByRole("button", { name: "Destroy environment" }),
			"Destroy environment",
		);
		expect(await destroy.count(), "the destroy confirmation offers exactly one confirm").toBe(1);

		await confirm.getByRole("button", { name: "Cancel" }).click();
		await expect(confirm).toHaveCount(0);
		// Cancel closed the dialog and nothing else: the settings card is still docked.
		await expect(rail(page)).toHaveAttribute("data-open", "true");
	});

	test("the Run menu offers Plan / Audit / Detect drift / Probe cluster, and nothing is clicked", async ({
		page,
	}) => {
		await page.getByRole("button", { name: "Run", exact: true }).click();

		for (const item of ["Plan", "Audit", "Detect drift", "Probe cluster"]) {
			await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
		}

		// These four queue REAL jobs against the environment, and neither guard in this file reaches
		// them: they post small-bodied server actions, which the payload watch cannot attribute. The
		// menu is opened and closed; that is the whole journey.
		await page.keyboard.press("Escape");
		await expect(page.getByRole("menuitem", { name: "Plan" })).toHaveCount(0);
	});

	test("Save clears the bar and a reload shows no pending changes", async ({ page }, testInfo) => {
		// This journey's own project, with a connected cloud account and a region, so its write stays
		// off the shared fixture. Seeded rows, fixture credentials, no cloud.
		const orgSlug = new URL(page.url()).pathname.split("/")[1] ?? "";
		const owner = await resolveOwner(orgSlug);
		const identity = await seedCloudIdentity(owner, { provider: "aws" });
		const project = await seedProject(owner, {
			name: `canvas-save-${testInfo.workerIndex}-${Date.now()}`,
			cloudIdentityId: identity.id,
		});
		await page.goto(`/${orgSlug}/${project.slug}/architecture`);
		await expect(
			page.getByRole("button", { name: "Add", exact: true }).first(),
		).toBeVisible({ timeout: 60_000 });

		// One staged change is what renders the bar.
		await addService(page, "Bucket");
		await expect(pendingBar(page)).toBeVisible();

		// Save persists the design WITHOUT provisioning: one request carries it, and nothing is queued.
		designWritesAllowed = 1;
		await pendingBar(page).getByRole("button", { name: "Save", exact: true }).click();

		// The bar diffs the draft against the saved baseline, so a saved design has no bar.
		await expect(pendingBar(page)).toHaveCount(0);
		await expect(card(page, /^Bucket/)).toHaveCount(1);

		await page.reload();

		// The saved card is still on the board, and nothing is pending: what came back from the
		// server is what was saved.
		await expect(
			card(page, /^Bucket/),
			"the saved bucket is on the board after the reload",
		).toHaveCount(1, { timeout: 60_000 });
		await expect(pendingBar(page)).toHaveCount(0);
	});

	test("? opens the shortcuts sheet, and it advertises only gestures this board binds", async ({
		page,
	}) => {
		await page.keyboard.press("?");
		const sheet = page.getByRole("dialog");
		await expect(sheet.getByRole("heading", { name: "Keyboard shortcuts" })).toBeVisible();
		await expect(sheet.getByText("Command palette")).toBeVisible();
		await expect(sheet.getByText("Add component")).toBeVisible();
		await expect(sheet.getByText("Duplicate selection")).toBeVisible();
		await expect(sheet.getByText("Undo / Redo")).toBeVisible();

		// A LIVE project has no save shortcut to advertise — `buildShortcuts(isMac, canSave)` drops
		// the row rather than promise a gesture that does nothing. This is the assertion that makes
		// the sheet a contract instead of a list.
		await expect(sheet.getByText("Save project")).toHaveCount(0);

		await page.keyboard.press("Escape");
		await expect(sheet).toHaveCount(0);
	});

	// ── the empty board and the seed link (#6836) ────────────────────────────────────────────────
	//
	// Every journey above adds a card first, so until these the guide and the `?seed=` path were
	// covered by component tests only. The fixture's blank project is exactly an empty board.

	test("an empty board shows the guide, its Add a component opens the picker, and the first card replaces it", async ({
		page,
	}) => {
		await expect(guide(page).getByText("Nothing designed yet")).toBeVisible();
		await expect(cards(page)).toHaveCount(0);

		await guide(page).getByRole("button", { name: "Add a component" }).click();
		const search = page.getByPlaceholder(/search services/i);
		await expect(search).toBeVisible();
		await search.fill("Bucket");
		await page.getByRole("option", { name: /bucket/i }).first().click();
		await expect(search).toBeHidden();

		await expect(card(page, /^Bucket/)).toHaveCount(1);
		// The guide is for a board with nothing on it; it does not linger under the first card.
		await expect(guide(page)).toHaveCount(0);
	});

	test("a ?seed= template link sizes the cluster once, says so, and leaves the URL", async ({
		page,
	}) => {
		await openWithSeed(page, "v1.template.standard.aws");

		// Dealt with, the param is removed, so a reload or a shared copy of the address cannot apply
		// it a second time.
		await expect(page).not.toHaveURL(/[?&]seed=/, { timeout: 30_000 });
		// A template sizes the cluster and draws no card, so the guide stays — and says what it did.
		await expect(
			guide(page).getByText(/The cluster is sized from the Standard template for /),
		).toBeVisible();
		await expect(page.locator("[data-slot=board-seed-notice]")).toHaveCount(0);
	});

	test("a ?seed= link that cannot be read says so in one sentence, and Dismiss removes it", async ({
		page,
	}) => {
		await openWithSeed(page, "v1.nonsense");

		const notice = page.locator("[data-slot=board-seed-notice]");
		await expect(notice).toContainText("This link's starting point could not be read");
		// The board works underneath the refusal: the guide is still there to start from.
		await expect(guide(page).getByText("Nothing designed yet")).toBeVisible();

		await notice.getByRole("button", { name: "Dismiss" }).click();
		await expect(notice).toHaveCount(0);
		await expect(page).not.toHaveURL(/[?&]seed=/);
	});

	// ── connections and the board's own keys (#6835) ─────────────────────────────────────────────

	test("dragging from a service's handle to a queue draws the connection and opens its Connections", async ({
		page,
	}) => {
		await addService(page, "Service");
		await addService(page, "Queue");
		await closeInspector(page);
		await moreMenu(page, "Fit view");

		// Two adds in a row land side by side, not one over the other (#7132 found the second card
		// covering the first card's handle). Nothing is rearranged before the drag: a freshly added
		// card has to be connectable where it landed.
		const service = await card(page, /^Service/).boundingBox();
		const queue = await card(page, /^Queue/).boundingBox();
		if (!service || !queue) throw new Error("both cards are drawn");
		const overlap =
			service.x < queue.x + queue.width &&
			queue.x < service.x + service.width &&
			service.y < queue.y + queue.height &&
			queue.y < service.y + service.height;
		expect(overlap).toBe(false);

		await dragConnection(page, card(page, /^Service/), card(page, /^Queue/));

		await expect(connection(page, /^Connection from Service .* to Queue/)).toHaveCount(1);
		// What a connection injects is the next choice, and it is made where the line now lives.
		await expect(rail(page)).toHaveAttribute("data-open", "true");
		await expect(rail(page).getByRole("tab", { name: "Connections" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
	});

	test("a refused connection draws nothing and says why, beside the card", async ({ page }) => {
		await addService(page, "Service");
		await addService(page, "Bucket");
		await closeInspector(page);
		await moreMenu(page, "Fit view");

		await dragConnection(page, card(page, /^Service/), card(page, /^Bucket/));

		// A service connects to a database, cache, queue or secret; a bucket is none of those.
		const note = page.getByTestId("connection-note");
		await expect(note).toHaveAttribute("data-refused", "true");
		await expect(note).toContainText("Bucket cannot be a connection target");
		await expect(connection(page, /^Connection from/)).toHaveCount(0);
	});

	test("C connects the selected service from a menu; a selected line is removed by Delete or its button, and ⌘Z restores it", async ({
		page,
	}) => {
		await addService(page, "Service");
		await addService(page, "Queue");
		await closeInspector(page);

		// No pointer at all: focus the service from the keyboard and press C.
		await keyboardFocus(page, card(page, /^Service/));
		await page.keyboard.press("c");
		const menu = page.getByRole("menu");
		await expect(menu.getByText("Connect service to")).toBeVisible();
		await menu.getByRole("menuitem", { name: /^Queue/ }).click();

		const line = connection(page, /^Connection from Service .* to Queue/);
		await expect(line).toHaveCount(1);

		// A line reached from the keyboard is the selection, so Delete removes it with no second step.
		await keyboardFocus(page, line);
		await expect(board(page).getByRole("button", { name: "Remove connection" })).toBeVisible();
		await page.keyboard.press("Delete");
		await expect(line).toHaveCount(0);

		// The removal edits the service's bindings as ONE undo step.
		await page.keyboard.press("ControlOrMeta+z");
		await expect(line).toHaveCount(1);

		// The selected line's own button does the same. It is pressed with the pointer, so the board
		// gets its full width back first: connecting opened the inspector, which narrows the board.
		await closeInspector(page);
		await moreMenu(page, "Fit view");
		await keyboardFocus(page, line);
		await board(page).getByRole("button", { name: "Remove connection" }).click();
		await expect(line).toHaveCount(0);
	});

	test("Enter opens the focused card in the inspector, and Delete removes it (⌘Z puts it back)", async ({
		page,
	}) => {
		await addService(page, "Bucket");
		await closeInspector(page);
		const bucket = card(page, /^Bucket/);

		await keyboardFocus(page, bucket);
		await page.keyboard.press("Enter");
		await expect(rail(page)).toHaveAttribute("data-open", "true");
		await expect(rail(page).getByPlaceholder("name", { exact: true })).toBeVisible();

		await keyboardFocus(page, bucket);
		await page.keyboard.press("Delete");
		await expect(bucket).toHaveCount(0);

		await page.keyboard.press("ControlOrMeta+z");
		await expect(bucket).toHaveCount(1);
	});

	test("an arrow key held on a card moves it, and one ⌘Z undoes the whole hold", async ({
		page,
	}) => {
		await addService(page, "Bucket");
		await closeInspector(page);
		const bucket = card(page, /^Bucket/);
		/** Where React Flow has drawn the card: its wrapper's transform. */
		const placed = () =>
			bucket.evaluate((el) => (el instanceof HTMLElement ? el.style.transform : ""));
		const before = await placed();
		expect(before).not.toBe("");

		await keyboardFocus(page, bucket);
		// Each further `down` without an `up` is a key REPEAT, which is what holding a key sends.
		for (let i = 0; i < 6; i++) await page.keyboard.down("ArrowRight");
		await page.keyboard.up("ArrowRight");
		await expect.poll(placed).not.toBe(before);

		// One step back is the whole hold — six repeats are not six steps — and it is the move that
		// is undone, not the add before it.
		await page.keyboard.press("ControlOrMeta+z");
		await expect.poll(placed).toBe(before);
		await expect(bucket).toHaveCount(1);
	});

	// ── accessibility ─────────────────────────────────────────────────────────────────────────────

	test("the shell has no serious or critical axe violations: empty, designed with the inspector open, and in review", async ({
		page,
	}) => {
		// Without the scanner, every scan below returns [] and would pass on its absence.
		await requireAxe();
		// The page's main region: the board, its toolbar, the inspector, the bar and the review view.
		const scope = { include: "main" };

		expect(await scanA11y(page, scope)).toEqual([]);

		await addService(page, "Service");
		await addService(page, "Queue");
		await expect(rail(page)).toHaveAttribute("data-open", "true");
		expect(await scanA11y(page, scope)).toEqual([]);

		// The review view gives way to the inspector, so the inspector is closed to show it.
		await closeInspector(page);
		await pendingBar(page).getByRole("button", { name: "Review plan", exact: true }).click();
		await expect(reviewView(page)).toBeVisible();
		expect(await scanA11y(page, scope)).toEqual([]);
	});
});
