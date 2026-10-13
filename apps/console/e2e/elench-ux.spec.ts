// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Regression cover for the Elench surface defects that shipped because nothing drove the UI:
//   · the @-mention menu rendered ON TOP of the text you were typing and could not scroll
//   · clicking an artifact silently created a chat named after it (or hijacked your last one)
//   · the rail carried an orphan "Chats" row and an unpadded search box
// These assert geometry and side-effects — the things a type-check can never see.
//
// Runs in the `elench-ai` PROJECT — the CI job `E2E (browser · Elench AI journeys · scripted
// model)`. It used to have an `elench-ux` project of its own that no workflow ever invoked, so
// "the reason this suite exists at all" ran nowhere (#2875). It belongs here on the evidence:
// it takes the same shared `setup` persona and storageState, and the artifact test below sends
// "Build a dashboard of my infrastructure" — the scripted `dashboard` scenario in
// lib/config/ai-mock.ts, whose four blocks are the four widget cards it asserts. Against an
// AI-off console that assertion can only ever 503, so this file needs ALETHIA_AI_MOCK=1.

import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, orgIdBySlug } from "./helpers/db";
import { seedProject } from "./helpers/seed";

const composer = (page: Page) => page.getByTestId("elench-composer");
const menu = (page: Page) => page.getByTestId("mention-menu");
const list = (page: Page) => page.getByTestId("mention-menu-list");

/**
 * Gives the persona's org enough taggable resources to overflow the @-mention menu.
 *
 * The scroll test below cannot assert scrolling against whatever the org happens to hold, and
 * for this persona that is NOTHING. `searchMentions` merges only the org's OWN projects,
 * clusters, jobs, connectors, runners, identities and artifacts — and filters connectors to
 * the connected ones (`app/server/actions/mentions.ts`: "Only connected connectors are
 * taggable"). That filter landed in 3bfb88fc on 2026-07-15, one day after this spec was
 * written against the assumption that "the connector catalog alone comfortably overflows the
 * menu". The catalog has not fed this menu since. Nothing caught it because the `elench-ux`
 * project ran in no job — which is the dead zone this PR closes.
 *
 * So the test owns its fixture. Projects are the cheapest mention source (a direct insert, no
 * cloud identity, no deploy), and 12 comfortably overflows a menu whose max height is at most
 * 320px against ~36px rows, while staying under MAX_RESULTS = 40.
 */
async function seedTaggableResources(page: Page, count: number): Promise<void> {
	await page.goto("/");
	const slug = new URL(page.url()).pathname.split("/").filter(Boolean)[0];
	if (!slug) throw new Error(`could not read an org slug from ${page.url()}`);

	const orgId = await orgIdBySlug(slug);
	if (!orgId) throw new Error(`no organization row for slug ${slug}`);

	// snake_case, NOT the camelCase the Drizzle schema object shows: `member` is generated with
	// `casing: "snake_case"` (0000_baseline.sql:523 — "organization_id", "user_id"). The sibling
	// helper pendingInvitationId() quotes "organizationId" because Better Auth's `invitation`
	// table really is camelCase; the two do not share a convention, so neither can be inferred
	// from the other.
	const rows = await db()<{ user_id: string }[]>`
		select user_id from member where organization_id = ${orgId} limit 1`;
	const userId = rows[0]?.user_id;
	if (!userId) throw new Error(`organization ${slug} has no member to own seeded projects`);

	for (let i = 0; i < count; i++) {
		await seedProject({ userId, orgId }, { name: `e2e-mention-${i}` });
	}
}

test.afterAll(async () => {
	await closeDb();
});

/** The message the mid-mention send test types; the claim helper finds its draft row by it. */
const MID_MENTION = "edit the @connectors thing";

/**
 * Waits until no draft of the persona is held `sending` with `text` — the claim its send took has
 * ended (consumed, or released). Reads the row directly: the claim is server state with no UI of
 * its own in the tab that holds it.
 */
async function expectNoClaimHeld(text: string): Promise<void> {
	await expect
		.poll(
			async () => {
				const rows = await db()<{ n: number }[]>`
					select count(*)::int as n from elench_drafts where status = 'sending' and text = ${text}`;
				return rows[0]?.n ?? -1;
			},
			{ timeout: 30_000 },
		)
		.toBe(0);
}

/** The status of the draft row holding `text`, or null when no row holds it. */
async function draftStatusOf(text: string): Promise<string | null> {
	const rows = await db()<{ status: string }[]>`
		select status from elench_drafts where text = ${text} order by revision desc limit 1`;
	return rows[0]?.status ?? null;
}

async function openElench(page: Page): Promise<void> {
	await page.goto("/");
	await page.getByRole("button", { name: "Ask AI" }).click();
	await page.getByRole("button", { name: /expand to full screen/i }).click();
	await expect(page.getByTestId("elench-modal")).toBeVisible();
	await expect(composer(page)).toBeVisible({ timeout: 30_000 });
}

/**
 * Opens Elench on a GUARANTEED-EMPTY thread — its own conversation, so its own draft key.
 *
 * `openElench` lands on whatever thread is active, and the whole suite shares one persona
 * and org across four workers — so "active" routinely means a thread another test just
 * finished talking in. Any test that COUNTS something the transcript produces has to start
 * from a known grid, or it is measuring the persona's history.
 *
 * Every test that TYPES into the composer starts here too, for the same reason one level down.
 * The composer belongs to the conversation's draft (ADR 0001), and a draft another test left
 * mid-send is frozen under that test's claim for its 120 s lease — read-only, "Being sent from
 * another tab or device" (D30). A test that sends a later turn and ends before the client consumed
 * the claim leaves exactly that, and the next test resumed the same conversation and typed into a
 * box that took no input: its `@` menu never opened (#5852). A fresh conversation has no row, so
 * no claim another test took can reach it.
 *
 * That is not hypothetical: the artifact test below asserted four widget cards from the
 * scripted dashboard's four blocks and got five. The fifth was "Connectors", pinned by an
 * `edit the @connectors thing` turn earlier on the same thread — there was never a fifth
 * block, there was a second turn. The sidebar in that run held seven chats, five of them
 * the same prompt, all within a minute.
 */
async function openFreshChat(page: Page): Promise<void> {
	await openElench(page);
	await page.getByRole("button", { name: "New chat" }).click();
	await expect(composer(page)).toBeVisible();
	// The grid belongs to the thread, so a new one starts with nothing on it. Asserting
	// that here is what makes the count downstream mean "this turn produced four".
	await expect(page.getByTestId("widget-card")).toHaveCount(0);
}

test.describe("Elench composer · @-mention menu", () => {
	test("opens ABOVE the composer and never covers the text you're typing", async ({
		page,
	}) => {
		await openFreshChat(page);
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
		// Seed BEFORE opening: the menu reads the org's own resources, and this persona's org is
		// empty by construction. Without this the list holds zero rows and cannot overflow, so the
		// assertion below would be measuring the fixture, not the container.
		await seedTaggableResources(page, 12);

		await openFreshChat(page);
		const editor = composer(page);
		await editor.click();
		await editor.pressSequentially("@");

		await expect(menu(page)).toBeVisible();

		// Wait for the (debounced, async) results to land AND overflow the menu's max height.
		//
		// This used to poll a row count past a magic 7 on the default 5s budget, and it failed
		// while the UI was perfectly fine: the mention search is debounced and can be the first
		// hit on a cold route when four workers start at once. Polling the OVERFLOW says what
		// the test actually needs — a list that does not overflow cannot demonstrate scrolling,
		// and a row count was only ever a proxy for that. If it never overflows, the failure is
		// now about the thing the test is named after.
		await expect
			.poll(
				async () => list(page).evaluate((el) => el.scrollHeight - el.clientHeight),
				{ timeout: 30_000 },
			)
			.toBeGreaterThan(0);

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

	test("Enter SENDS a message that contains an @token typed past a mention", async ({
		page,
	}) => {
		// Regression: typing PAST a mention ("edit the @connectors thing") closes the menu, but
		// Lexical's onClose didn't fire, so the composer's menu-open guard stayed stuck and Enter
		// inserted a newline instead of sending. Any @-mention mid-message could not be sent.
		await openFreshChat(page);
		const editor = composer(page);
		await editor.click();
		await editor.pressSequentially(MID_MENTION);
		await page.waitForTimeout(300);
		await editor.press("Enter");
		// If it sent, the composer clears; if Enter made a newline, the text is still there.
		await expect(editor).toHaveText(/^\s*$/, { timeout: 5000 });
		await expect(page.getByText(MID_MENTION, { exact: true }).first()).toBeVisible();

		// Let the send FINISH before the page closes. The message renders only after the claim is
		// granted (the store claims, then starts the turn), so the row was `sending` by now; it
		// leaves that state only when this tab consumes the claim after the route answers. Closing
		// earlier held the claim for its 120 s lease (#5852) — harmless to the fresh conversations
		// the other tests use, but a test should not leave a live claim behind it.
		await expectNoClaimHeld(MID_MENTION);
	});

	test("↓ then Enter inserts an atomic pill; Backspace deletes it whole", async ({
		page,
	}) => {
		await openFreshChat(page);
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

		// Chats are user-scoped: no workspace switcher, and no orphan "Chats" nav row.
		await expect(
			page.getByRole("button", { name: "Chats", exact: true }),
		).toHaveCount(0);
		await expect(page.getByTestId("workspace-switcher")).toHaveCount(0);

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

		// And it can be removed again — behind a confirmation (#4280), so the delete is two steps.
		await page.getByRole("button", { name: `Delete document ${title}` }).click();
		await page.getByRole("button", { name: "Delete document", exact: true }).click();
		await expect(page.getByTestId("knowledge-doc")).toHaveCount(0);
	});
});

test.describe("Elench artifacts", () => {
	test("clicking an artifact opens a viewer and does NOT create a chat", async ({
		page,
	}) => {
		// A fresh thread, so the four cards below are THIS turn's four and not the org's history.
		await openFreshChat(page);

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

test.describe("Elench drafts · a send cut off mid-flight", () => {
	test("a tab closed mid-send leaves the draft 'being sent elsewhere' until the lease settles it as sent", async ({
		page,
	}) => {
		// The lease is 120 s (lib/elench/draft-claims.ts, ADR 0001 §3.4 S5) and the reopened tab
		// re-lists every 10 s while a row is claimed elsewhere, so the settle lands inside ~135 s.
		test.setTimeout(240_000);

		// Its own conversation: the claim this test leaves must be the only one it can see.
		await openFreshChat(page);
		const stamp = Date.now();
		const first = `lease probe ${stamp}`;
		const second = `lease probe ${stamp} again`;
		const reply = "Alethia provisions infrastructure as Projects";

		// A FIRST turn cannot leave a held claim: `startConversation` consumes it in the transaction
		// that stores the turn. So the turn that is cut off is a later one, as in #5852.
		const editor = composer(page);
		await editor.click();
		await editor.pressSequentially(first);
		await editor.press("Enter");
		await expect(page.getByText(reply).first()).toBeVisible({ timeout: 60_000 });
		await expectNoClaimHeld(first);

		// Cut the later send off mid-flight, deterministically: the server runs the turn to the end
		// and stores it (`route.fetch` reads the whole stream), but this tab never gets the answer,
		// so it never consumes its claim. A real close lands at some point in that window; this
		// pins it after the turn is stored, the case a lease settle consumes rather than releases.
		let routeStatus = 0;
		let markStored: () => void = () => undefined;
		const stored = new Promise<void>((resolve) => {
			markStored = resolve;
		});
		await page.route("**/api/agent", async (route) => {
			const res = await route.fetch();
			routeStatus = res.status();
			markStored();
		});
		await editor.click();
		await editor.pressSequentially(second);
		await editor.press("Enter");
		await stored;
		expect(routeStatus).toBe(200);
		// The claim is held: the row is still `sending` with the words of the stored turn.
		expect(await draftStatusOf(second)).toBe("sending");
		await page.close();

		// Reopen the same conversation in another tab.
		const reopened = await page.context().newPage();
		await openElench(reopened);
		await reopened.getByTestId("thread-rail-row").filter({ hasText: first }).first().click();
		const box = composer(reopened);
		const status = reopened.getByTestId("elench-draft-status");

		// D30: the box is read-only and says why.
		await expect(status).toContainText("Being sent from another tab or device.", {
			timeout: 30_000,
		});
		await expect(box).toHaveAttribute("contenteditable", "false");

		// The lease runs out; the next list settles the silent claim and, the turn being stored,
		// consumes it. The box opens again, the tab says the message went out from elsewhere, and
		// the turn it never saw answered is in the transcript.
		await expect(box).toHaveAttribute("contenteditable", "true", { timeout: 180_000 });
		await expect(status).toContainText("This message was sent from another tab or device.");
		await expect(reopened.getByText(second, { exact: true }).first()).toBeVisible();
		expect(await draftStatusOf(second)).not.toBe("sending");
	});
});
