// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The PROJECT assistant (Elench opened inside a project → POST /api/projects/[projectId]/assistant,
// `buildProjectAgentTools`) against a REAL model — the AI soak's project lane (epic "AI feature soak
// before 2026-12-12", #7840). Runs in the `elench-live` project: nightly at Haiku, and on a PR that
// changes the project assistant (e2e-ai-nightly.yml on the PR, until 2026-12-12).
//
// Behaviour, never wording:
//   · a cost question reaches `estimate_cost` (which prices the live canvas the panel sends) and
//     its frame completes;
//   · a design change comes back as a `propose_changes` card, and Dismiss leaves the board exactly
//     as it was — the same number of cards — because a proposal is applied only on Accept;
//   · the conversation is scoped to the environment the user is LOOKING AT: opened on a seeded
//     NON-default environment, the plan proposal the model raises names that environment's id, and
//     Reject queues nothing. A proposal that omitted the id would plan the project's DEFAULT
//     environment, which is why the seed gives the project two.
//
// The persona org is seeded at `AI_SOAK_TIER` (default ai_plus) — see e2e/helpers/ai-tier.ts.

import { expect, test, type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { completedAnswer, completedToolFrame, waitForTurn } from "./helpers/ai-live";
import { personaOrgSlug, personaOwner, seedAiTier, soakTier } from "./helpers/ai-tier";
import { db } from "./helpers/db";
import { untilPageHydrated } from "./helpers/hydration";
import { seedProject, type SeededProject } from "./helpers/seed";
import { STORAGE_STATE } from "./fixtures/auth";

test.skip(!process.env.ANTHROPIC_API_KEY, "needs a real ANTHROPIC_API_KEY on the console under test");

// Real models think; give them room.
test.setTimeout(240_000);

let orgSlug = "";
let project: SeededProject;
/** A second, NON-default environment of the seeded project — the one the scope journey opens on. */
let stagingEnvId = "";

/** The docked project assistant (components/agent/elench/elench-panel.tsx). */
function panel(page: Page): Locator {
	return page.getByRole("dialog", { name: "Elench assistant" });
}

/** The chat's error card inside the panel's transcript, matched by role, not copy. */
function panelError(page: Page): Locator {
	return panel(page).getByRole("region", { name: "Messages" }).getByRole("alert");
}

/** Every card drawn on the architecture board. */
function boardCards(page: Page): Locator {
	return page.locator(".react-flow .react-flow__node");
}

/**
 * Open the project's architecture canvas (on `environmentId` when given), wait until the board is
 * interactive, and open the assistant from the topbar — which scopes it to THIS project and the
 * environment in the URL (components/shell/ask-ai-button.tsx). Starts a fresh conversation.
 */
async function openProjectAssistant(page: Page, environmentId?: string): Promise<void> {
	const query = environmentId ? `?environment_id=${environmentId}` : "";
	await page.goto(`/${orgSlug}/${project.slug}/architecture${query}`);
	await expect(page.getByRole("button", { name: "Add", exact: true }).first()).toBeVisible({
		timeout: 60_000,
	});
	await untilPageHydrated(page);
	await page.getByRole("button", { name: "Ask AI" }).click();
	await expect(panel(page)).toBeVisible();
	const fresh = panel(page).getByRole("button", { name: "New conversation" });
	if (await fresh.isVisible().catch(() => false)) await fresh.click();
}

/** Send a message through the panel's composer. */
async function askProject(page: Page, text: string): Promise<void> {
	const composer = panel(page).getByTestId("elench-composer");
	await composer.fill(text);
	await composer.press("Enter");
}

/** The stored shape of a `propose_operation` part, as far as this spec reads it. */
const proposalPartSchema = z.object({
	type: z.literal("tool-propose_operation"),
	input: z.object({ operation: z.object({ environmentId: z.string().optional() }).passthrough() }).passthrough(),
});
const storedMessagesSchema = z.array(z.object({ parts: z.array(z.unknown()).default([]) }).passthrough());

/**
 * The `environmentId` of every `propose_operation` the project's newest thread holds (the route
 * stores the transcript, UIMessage[] JSONB, in `agent_threads.messages`). `undefined` entries are
 * proposals that omitted the id.
 */
async function proposedEnvironmentIds(): Promise<(string | undefined)[]> {
	const rows = await db()<{ messages: unknown }[]>`
		select messages from agent_threads
		where project_id = ${project.projectId}
		order by updated_at desc limit 1`;
	const messages = storedMessagesSchema.safeParse(rows[0]?.messages ?? []).data ?? [];
	const ids: (string | undefined)[] = [];
	for (const message of messages) {
		for (const part of message.parts) {
			const parsed = proposalPartSchema.safeParse(part);
			if (parsed.success) ids.push(parsed.data.input.operation.environmentId);
		}
	}
	return ids;
}

test.describe(`Project assistant with a REAL model · ${soakTier()}`, () => {
	test.beforeAll(async ({ browser }, testInfo) => {
		const context = await browser.newContext({
			storageState: STORAGE_STATE,
			baseURL: testInfo.project.use.baseURL,
		});
		const page = await context.newPage();
		orgSlug = await personaOrgSlug(page);
		await seedAiTier(orgSlug);
		const owner = await personaOwner(orgSlug);
		project = await seedProject(owner, { name: `soak-proj-${Date.now()}` });
		const [env] = await db()<{ id: string }[]>`
			insert into project_environments ${db()({
				project_id: project.projectId,
				user_id: owner.userId,
				org_id: owner.orgId,
				name: "staging",
				stage: "staging",
				status: "DRAFT",
				is_default: false,
				region: "eu-central-1",
			})}
			returning id`;
		stagingEnvId = env.id;
		// ONE card on the default environment's board, for the Dismiss journey to count before and
		// after. `seedProject` writes only `project_network` + `project_cluster`, and since W2 the board
		// draws neither (they are environment settings, not cards — canvas-flow.tsx), so its board is
		// the empty-board guide. A database is drawn as a card "Database <name>" (the same reasoning
		// as e2e/audit/fixtures-destructive.ts's `audit-db`).
		await db()`
			insert into project_databases ${db()({
				project_id: project.projectId,
				org_id: owner.orgId,
				environment_id: project.envId,
				name: "soak-db",
				engine_family: "postgres",
				status: "PENDING",
			})}`;
		// Every journey asks about this project from inside it. If the console cannot open its board,
		// each would fail as a model problem when it is a fixture problem — say so here instead.
		await page.goto(`/${orgSlug}/${project.slug}/architecture`);
		await expect(
			page.getByRole("button", { name: "Add", exact: true }).first(),
			`seeded project ${project.projectId} (org ${owner.orgId}) has no board at /${orgSlug}/${project.slug}/architecture`,
		).toBeVisible({ timeout: 60_000 });
		await context.close();
	});

	test("a cost question reaches estimate_cost on the live canvas", async ({ page }) => {
		await openProjectAssistant(page);
		await askProject(page, "Roughly what will this project cost per month? Estimate it with your tools.");
		await waitForTurn(page, completedToolFrame(page, ["estimate_cost"]).first(), 180_000, panelError(page));
		await waitForTurn(page, completedAnswer(panel(page)), 150_000, panelError(page));
	});

	test("a design change comes back as a proposal, and Dismiss leaves the board unchanged", async ({ page }) => {
		await openProjectAssistant(page);
		// `count()` does not wait, so wait for the seeded card to be drawn before counting.
		const seededCard = page.locator(".react-flow").getByRole("group", { name: /soak-db/ });
		await expect(seededCard, "the seeded board draws its database card").toBeVisible({ timeout: 30_000 });
		const before = await boardCards(page).count();
		expect(before, "the seeded board draws its cards").toBeGreaterThan(0);

		await askProject(page, "Add a Redis cache to this design.");
		const card = page.locator('[data-slot="tool-result-frame"]').filter({
			has: page.getByRole("button", { name: "Dismiss" }),
		});
		await waitForTurn(page, card.first(), 180_000, panelError(page));
		// Nothing is applied while the proposal waits on the person.
		expect(await boardCards(page).count()).toBe(before);

		await card.first().getByRole("button", { name: "Dismiss" }).click();
		await expect(panel(page).getByText("Dismissed").first()).toBeVisible();
		await expect(card).toHaveCount(0);
		// The dismissal goes back to the model, which continues the turn; the board stays as it was.
		await waitForTurn(page, completedAnswer(panel(page)), 150_000, panelError(page));
		expect(await boardCards(page).count()).toBe(before);
	});

	test("opened on a non-default environment, the plan proposal names it — and Reject queues nothing", async ({ page }) => {
		await openProjectAssistant(page, stagingEnvId);
		await askProject(page, "Plan this environment so I can review what would be created.");
		const approve = panel(page).getByRole("button", { name: "Approve & plan" }).first();
		await waitForTurn(page, approve, 180_000, panelError(page));

		await expect
			.poll(proposedEnvironmentIds, { timeout: 30_000, message: "the proposal is stored on the thread" })
			.not.toHaveLength(0);
		const ids = await proposedEnvironmentIds();
		for (const id of ids) {
			expect(id, `the plan proposal targets the staging environment ${stagingEnvId}, not the default ${project.envId}`).toBe(
				stagingEnvId,
			);
		}

		await panel(page).getByRole("button", { name: "Reject" }).first().click();
		await expect(approve).toHaveCount(0);
		const jobs = await db()<{ n: number }[]>`
			select count(*)::int as n from jobs where project_id = ${project.projectId}`;
		expect(jobs[0]?.n ?? 0, "a rejected proposal queues no job").toBe(0);
	});
});
