// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Dashboards and saved artifacts against a REAL model (the AI soak, epic #7840, lane #7838). Runs
// in the `elench-live` project: nightly at Haiku, and on a PR that changes the dashboard or artifact
// tools (e2e-ai-nightly.yml on the PR, until 2026-12-12).
//
// The journeys, in declaration order (CI runs one worker):
//   1. the model builds a dashboard on the grid, and the person saves it as a named artifact through
//      the grid's own "Save dashboard as artifact" popover — then a fresh chat's Artifacts library
//      shows its card;
//   2. the model is asked to add a widget to THAT artifact: `get_artifact` then `update_artifact`
//      complete, and the stored spec (`agent_artifacts.spec.widgets`) holds one more widget than
//      before — read from the database, because "the viewer shows one more block" depends on which
//      surface happens to be open, and the row is what every later chat loads;
//   3. in a fresh conversation, `list_artifacts` finds it.
//
// Assertions are BEHAVIOUR, never wording: tool frames by name + "Completed", test ids, the stored
// row. The artifact's own name is a datum the test chose, so seeing it in the transcript is not a
// wording assertion.
//
// NOT serial (a serial group retries every journey when one fails, paying three times for the ones
// that passed). So journeys 2 and 3 do not depend on journey 1 having passed: if the UI save did not
// happen, they insert the artifact row themselves — exactly the row `saveArtifact` writes (owner-
// private: `user_id = org_id = <persona user id>`, app/server/actions/artifacts.ts) — and journey 1
// stays the only one that can fail on the save flow.

import { expect, test, type Page } from "@playwright/test";
import { ask, completedToolFrame, openElenchModal, waitForTurn } from "./helpers/ai-live";
import { db } from "./helpers/db";
import { personaOrgSlug, personaOwner, seedAiTier, soakTier } from "./helpers/ai-tier";
import { STORAGE_STATE } from "./fixtures/auth";

test.skip(!process.env.ANTHROPIC_API_KEY, "needs a real ANTHROPIC_API_KEY on the console under test");

// Real models think; give them room.
test.setTimeout(240_000);

const TIER = soakTier();
/** Unique per run: artifact names are unique per owner (`uq_agent_artifacts_org_name`). */
const ARTIFACT = `soak-ops-${Date.now()}`;

/** The persona's user id — the owner `saveArtifact` stamps on both `user_id` and `org_id`. */
let ownerUserId = "";

/** How many widgets the stored artifact holds, or null when no such artifact exists. */
async function storedWidgetCount(): Promise<number | null> {
	const rows = await db()<{ n: number }[]>`
		select jsonb_array_length(spec->'widgets')::int as n from agent_artifacts
		where user_id = ${ownerUserId} and name = ${ARTIFACT} limit 1`;
	return rows[0]?.n ?? null;
}

/**
 * Make sure the artifact exists, so a journey that reads or edits it does not fail because an
 * EARLIER journey did. Inserts the same owner-private row `saveArtifact` writes: one live stat
 * widget sourced from `list_clusters`, valid against `artifactSpecSchema`.
 */
async function ensureArtifact(): Promise<void> {
	if ((await storedWidgetCount()) !== null) return;
	const sql = db();
	await sql`
		insert into agent_artifacts (user_id, org_id, name, kind, spec)
		values (${ownerUserId}, ${ownerUserId}, ${ARTIFACT}, 'dashboard', ${sql.json({
			widgets: [
				{
					kind: "stat",
					title: "Active clusters",
					source: { tool: "list_clusters", args: null },
					data: {},
					mode: "live",
					position: { x: 0, y: 0 },
					size: { colspan: 2, rowspan: 2 },
				},
			],
		})})
		on conflict do nothing`;
}

/** Start a brand-new conversation in the open Elench surface. */
async function newChat(page: Page): Promise<void> {
	await page.getByRole("button", { name: /new chat/i }).first().click();
}

test.describe(`Elench dashboards and artifacts with a REAL model · ${TIER}`, () => {
	test.beforeAll(async ({ browser }, testInfo) => {
		const context = await browser.newContext({
			storageState: STORAGE_STATE,
			baseURL: testInfo.project.use.baseURL,
		});
		const page = await context.newPage();
		const slug = await personaOrgSlug(page);
		await seedAiTier(slug, TIER);
		ownerUserId = (await personaOwner(slug)).userId;
		await context.close();
	});

	test.beforeEach(async ({ page }) => {
		await openElenchModal(page);
	});

	test("builds a dashboard, saves it as an artifact, and a fresh chat's library shows it", async ({ page }) => {
		await ask(page, "Build a dashboard of my infrastructure — clusters, recent jobs and runners — on the grid.");
		await waitForTurn(page, page.getByTestId("widget-card").first(), 180_000);

		await page.getByRole("button", { name: /^save dashboard as artifact$/i }).click();
		await page.getByRole("textbox", { name: "Artifact name" }).fill(ARTIFACT);
		await page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(page.getByText("Saved.")).toBeVisible({ timeout: 30_000 });
		await expect.poll(storedWidgetCount, { timeout: 15_000 }).toBeGreaterThan(0);

		await newChat(page);
		await page.getByRole("button", { name: "Artifacts", exact: true }).click();
		await expect(page.getByTestId("artifact-card").filter({ hasText: ARTIFACT })).toBeVisible({
			timeout: 30_000,
		});
	});

	test("adds a widget to the saved artifact: get_artifact then update_artifact, one more stored widget", async ({ page }) => {
		await ensureArtifact();
		const before = (await storedWidgetCount()) ?? 0;

		await ask(
			page,
			`Add one more widget, showing my recent jobs, to my saved artifact named "${ARTIFACT}". Keep its existing widgets.`,
		);
		await waitForTurn(page, completedToolFrame(page, ["get_artifact"]).first(), 180_000);
		await waitForTurn(page, completedToolFrame(page, ["update_artifact"]).first(), 200_000);
		await expect.poll(storedWidgetCount, { timeout: 15_000 }).toBeGreaterThan(before);
	});

	test("list_artifacts finds the saved artifact in a fresh conversation", async ({ page }) => {
		await ensureArtifact();
		await ask(page, "Which saved artifacts do I have? Use the tools.");
		await waitForTurn(page, completedToolFrame(page, ["list_artifacts"]).first(), 150_000);
		await expect(
			page.getByRole("dialog", { name: "Elench" }).getByRole("region", { name: "Messages" }).getByText(ARTIFACT).first(),
		).toBeVisible({ timeout: 150_000 });
	});
});
