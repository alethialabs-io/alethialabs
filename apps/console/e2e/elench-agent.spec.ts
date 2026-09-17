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
//
// THIS FILE OWNS THE INSIDE OF THE ASSISTANT. Since `/{org}/~/agent` stopped being a route, the
// agent is reached only through the topbar "Ask AI" control — which every test below opens, from
// the org home. `e2e/flows/agent-usage-activity.spec.ts` therefore carries exactly one Ask AI
// test, and it is the one this file cannot make: that the launcher is a TOPBAR affordance,
// reachable from an arbitrary authenticated route rather than only from the home page (#4272).
// Anything about the panel, the modal, the composer or the threads belongs here, once.

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
		await expect(page.getByTestId("elench-composer")).toBeVisible();
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

	// The model picker carries the same defect and #4618 does not name it: same file, same
	// primitive, same `active && "bg-muted"` + unnamed `<Check>` as its only marks of which is
	// current. Fixed and measured with the segments rather than left as a second instance.
	test("the response-style segments expose which one is current", async ({ authedPage: page }) => {
		await page.getByRole("button", { name: "Response style" }).first().click();
		const group = page.getByRole("group", { name: "Response style" });
		const fast = group.getByRole("button", { name: /fast/i });
		const thinking = group.getByRole("button", { name: /thinking/i });

		await expect(fast).toHaveAttribute("aria-pressed", "true");
		await expect(thinking).toHaveAttribute("aria-pressed", "false");

		await thinking.click();
		await expect(thinking).toHaveAttribute("aria-pressed", "true");
		await expect(fast).toHaveAttribute("aria-pressed", "false");
	});

	test("the @-mention popover opens against real resources", async ({
		authedPage: page,
	}) => {
		const composer = page.getByTestId("elench-composer");
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
		const composer = page.getByTestId("elench-composer");
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

// THE MODE SEGMENTS THEMSELVES SAY NOTHING (#4618) — until this change they said it only with a
// `<Check>` glyph carrying no accessible name and an `isAsk && "bg-muted"` background, neither of
// which reaches the accessibility tree. "Ask-mode popover switches ask ↔ auto" above measures the
// PILL, so the mode was recoverable by closing the popover and re-reading the trigger; this test
// measures the SEGMENTS, which is the control's own state.
//
// `aria-pressed` on a `role="group"`, NOT the `role="menuitemradio"` + `aria-checked` the issue
// prescribed. That role's required context is a `menu`, and this popover cannot provide one:
// `@repo/ui/popover` is base-ui, whose `PopoverRoot` calls floating-ui's `useRole(ctx)` with no
// options, and that hook defaults to `role = 'dialog'`. A `menuitemradio` in a dialog is in an
// invalid context — assistive tech forms no radio set there — so the original assertion could have
// gone green over a tree that announces nothing. The house pattern is stated in
// `packages/ui/src/segmented-control.tsx`, and the closest precedent is the same shape behind the
// same primitive: `components/overview/overview-toolbar.tsx`'s `SortRow`.
//
// THE DESCRIBE AND THE TITLE ARE UNCHANGED ON PURPOSE. They are the `gate-baseline.json` key, and
// that file is owned by another open unit (#4633, #4273 — `scripts/ci/check-pr-scope.mjs` fails a
// PR that carries it), so this PR cannot move the ledger. Renaming the test here would leave the
// baseline naming a test the run no longer contains, which the ratchet refuses. What this PR does
// change is the `test.fixme`, which is gone: the test RUNS now. Its entry still reads `{fixme}`,
// so the (non-required) gate will report "baseline says fixme, the run says passed — now move the
// ledger", which is the correct prompt for whoever owns that file next.
//
// EACH ASSERTION READS THE ATTRIBUTE, NOT ONLY THE ROLE AND NAME. `getByRole("button", {name})`
// alone still resolves on the unfixed tree — these were already `<button>`s with those exact
// visible names — so a role-and-name-only test passes on the defect it exists to catch. And both
// sides are asserted: a control that reports every option pressed passes a one-sided assertion.
test.describe("Elench agent — Ask-mode segments (org)", () => {
	test("the Ask-mode segments expose which one is current", async ({ authedPage: page }) => {
		// Opened here rather than in a `beforeEach`, as when this was a fixme: the describe holds
		// exactly this test, so the walk is the test's own.
		await openElenchModal(page);
		await page.getByRole("button", { name: "Ask", exact: true }).first().click();
		const group = page.getByRole("group", { name: "Editing mode" });
		const ask = group.getByRole("button", { name: /ask before editing/i });
		const auto = group.getByRole("button", { name: /automatically edit/i });

		await expect(ask).toHaveAttribute("aria-pressed", "true");
		await expect(auto).toHaveAttribute("aria-pressed", "false");

		await auto.click();
		await expect(auto).toHaveAttribute("aria-pressed", "true");
		await expect(ask).toHaveAttribute("aria-pressed", "false");
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
		const composer = page.getByTestId("elench-composer");
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
		const composer = page.getByTestId("elench-composer");
		await composer.fill("anything at all");
		await composer.press("Enter");
		await expect(page.getByText(/ai is not configured/i)).toBeVisible();
		await expect(page.getByRole("button", { name: /retry/i })).toBeVisible();
	});
});
