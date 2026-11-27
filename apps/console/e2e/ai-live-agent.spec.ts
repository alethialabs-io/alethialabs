// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench agent against a REAL model, feature by feature (the AI soak, epic "AI feature soak
// before 2026-12-12"). Runs in the `elench-live` project: nightly at Haiku, and several times a day
// across the AI tiers from the soak jobs in e2e-ai-nightly.yml until the promotional credit expires.
//
// What each journey asserts is BEHAVIOUR, never wording: which tool family ran (by the tool frame's
// name and its "Completed" status), whether a person-approval card appeared, whether the grid got a
// widget — and, read back from the console's own usage ledger, which MODEL actually served the turn.
// That last one is the only way to prove the tier routing (Plus advisor, Max deep reasoning, the
// "Thinking" pick) against the real provider: the UI says nothing about which model answered.
//
// The persona org is seeded at `AI_SOAK_TIER` (default ai_plus) — see e2e/helpers/ai-tier.ts.

import { expect, test } from "@playwright/test";
import {
	ask,
	completedAnswer,
	completedToolFrame,
	openElenchModal,
	waitForTurn,
} from "./helpers/ai-live";
import {
	isCommunityEdition,
	ledgerByModel,
	outstandingHolds,
	personaOrgSlug,
	personaOwner,
	seedAiTier,
	soakTier,
} from "./helpers/ai-tier";
import { STORAGE_STATE } from "./fixtures/auth";
import { seedDrift, seedProject, type SeededProject } from "./helpers/seed";

test.skip(!process.env.ANTHROPIC_API_KEY, "needs a real ANTHROPIC_API_KEY on the console under test");

// Real models think; give them room.
test.setTimeout(240_000);

const TIER = soakTier();
const ADVISOR_PLUS = process.env.AI_ADVISOR_MODEL_PLUS || "anthropic/claude-sonnet-4-6";
const ADVISOR_MAX = process.env.AI_ADVISOR_MODEL_MAX || "anthropic/claude-opus-4-8";
/** The "Thinking" response style is an allowlisted client pick (lib/config/ai.ts AI_MODELS[1]). */
const THINKING_MODEL = "anthropic/claude-sonnet-4-6";
/**
 * Whether this console meters AI usage into the ledger. A console with no billing provider is the
 * self-host shape: `assertAiAllowed` returns a zero fixed charge and NOTHING is written to
 * `ai_usage_ledger` (lib/billing/ai-guard.ts, "Self-host bypass"), so a ledger assertion there can
 * only read zero. The soak jobs in e2e-ai-nightly.yml boot the console with Stripe's TEST key — the hosted shape
 * production runs — and the ledger journeys run there; the nightly has no key and skips them.
 */
const METERED = Boolean(process.env.STRIPE_SECRET_KEY);

let orgId = "";
let project: SeededProject;

/** Settled ledger rows this org has for `model`. */
async function rowsFor(model: string): Promise<number> {
	return (await ledgerByModel(orgId)).find((r) => r.model === model)?.rows ?? 0;
}

test.describe(`Elench agent with a REAL model · ${TIER}`, () => {
	// NOT serial: with `retries: 2` a serial group retries every journey when one fails, which on a
	// real model is paying three times for the ones that passed. CI runs one worker, so declaration
	// order still holds and the ledger check below still runs after the turns.
	test.beforeAll(async ({ browser }, testInfo) => {
		// beforeAll has no `page` fixture, and a bare browser.newContext() carries neither the persona
		// nor the project's baseURL — pass both.
		const context = await browser.newContext({
			storageState: STORAGE_STATE,
			baseURL: testInfo.project.use.baseURL,
		});
		const page = await context.newPage();
		const slug = await personaOrgSlug(page);
		await seedAiTier(slug, TIER);
		const owner = await personaOwner(slug);
		orgId = owner.orgId;
		project = await seedProject(owner, { name: `soak-shop-${Date.now()}` });
		await seedDrift(project, { drifted: 2 });
		// The journeys below ask the model about this project by name. If the console itself cannot
		// see it, every one of them would fail as "the model did not find the project" — which reads
		// as a model regression and is a fixture problem. Assert the seed is visible first, and say
		// exactly what was seeded where when it is not.
		await page.goto(`/${slug}`);
		await expect(
			page.getByText(project.name).first(),
			`seeded project ${project.projectId} (org ${owner.orgId}, user ${owner.userId}) is not on /${slug}`,
		).toBeVisible({ timeout: 30_000 });
		await context.close();
	});

	test.beforeEach(async ({ page }) => {
		await openElenchModal(page);
	});

	test("grounds a how-to in the docs (search_docs) or offers the one-click connect", async ({ page }) => {
		await ask(page, "How do I connect a Google Cloud project to Alethia? Check the docs.");
		await waitForTurn(page, completedToolFrame(page, ["search_docs", "connect_cloud"]).first(), 150_000);
		await waitForTurn(page, completedAnswer(page), 150_000);
	});

	test("reads a seeded project's drift with get_drift_posture", async ({ page }) => {
		await ask(page, `Has anything in my project "${project.name}" drifted from what was provisioned?`);
		await waitForTurn(page, completedToolFrame(page, ["get_drift_posture"]).first(), 180_000);
	});

	test("pins a widget to the grid on request", async ({ page }) => {
		await ask(page, "Put my recent jobs on the grid as a widget.");
		await waitForTurn(page, page.getByTestId("widget-card").first(), 180_000);
	});

	test("reads the AI allowance with get_ai_usage", async ({ page }) => {
		await ask(page, "How much of my AI allowance have I used this week? Use the tools.");
		await waitForTurn(page, completedToolFrame(page, ["get_ai_usage"]).first(), 150_000);
	});

	test("in Auto (act) mode, a plan request raises a person-approval card — and Reject changes nothing", async ({ page }) => {
		await page.getByRole("button", { name: "Ask", exact: true }).first().click();
		await page.getByText("Automatically edit").click();
		await expect(page.getByRole("button", { name: "Auto", exact: true }).first()).toBeVisible();

		await ask(page, `Plan the production environment of my project "${project.name}".`);
		// propose_operation has no execute: the turn pauses on the card until a person decides.
		const approve = page.getByRole("button", { name: "Approve & plan" }).first();
		await waitForTurn(page, approve, 180_000);
		await page.getByRole("button", { name: "Reject" }).first().click();
		await expect(approve).toHaveCount(0);
	});

	test("the Plus advisor actually served step 0 (ledger row for the advisor model)", async ({ page }) => {
		test.skip(!METERED, "this console meters nothing (no billing provider), so the ledger cannot answer");
		test.skip(isCommunityEdition(), "community has no AI tiers — the executor plans every turn");
		test.skip(TIER === "ai_free", "the free tier has no advisor — the executor plans");
		const before = await rowsFor(ADVISOR_PLUS);
		await ask(page, "Are my connectors healthy? Use the tools to check.");
		await waitForTurn(page, completedToolFrame(page, ["list_connectors"]).first(), 150_000);
		await waitForTurn(page, completedAnswer(page), 150_000);
		await expect.poll(() => rowsFor(ADVISOR_PLUS), { timeout: 30_000 }).toBeGreaterThan(before);
	});

	test("the Thinking response style routes the turn to its model", async ({ page }) => {
		test.skip(!METERED, "this console meters nothing (no billing provider), so the ledger cannot answer");
		await page.getByRole("button", { name: "Response style" }).first().click();
		const thinking = page.getByRole("group", { name: "Response style" }).getByRole("button", { name: /thinking/i });
		await thinking.click();
		await expect(thinking).toHaveAttribute("aria-pressed", "true");
		await page.keyboard.press("Escape");

		const before = await rowsFor(THINKING_MODEL);
		await ask(page, "In two sentences, when should I split one project into two environments?");
		await waitForTurn(page, completedAnswer(page), 150_000);
		await expect.poll(() => rowsFor(THINKING_MODEL), { timeout: 30_000 }).toBeGreaterThan(before);
	});

	test("on Max, Deep reasoning routes the advisor to the Max model", async ({ page }) => {
		test.skip(!METERED, "this console meters nothing (no billing provider), so the ledger cannot answer");
		test.skip(isCommunityEdition() || TIER !== "ai_max", "Deep reasoning renders only on the ai_max tier");
		const deep = page.getByRole("button", { name: "Deep reasoning" });
		await deep.click();
		await expect(deep).toHaveAttribute("aria-pressed", "true");

		const before = await rowsFor(ADVISOR_MAX);
		await ask(page, `Review my project "${project.name}" and tell me the single riskiest thing about it. Use the tools.`);
		await waitForTurn(page, completedAnswer(page), 200_000);
		await expect.poll(() => rowsFor(ADVISOR_MAX), { timeout: 30_000 }).toBeGreaterThan(before);
	});

	// Last, so it reads every turn above: a finished turn must leave no reservation behind (#2683 —
	// the contract on assertAiAllowed is that a settled turn "never leaks its hold"), and every row
	// a real model served must carry a real cost.
	test("every finished turn settled its hold and priced its cost", async () => {
		test.skip(!METERED, "this console meters nothing (no billing provider), so there are no holds to settle");
		await expect.poll(() => outstandingHolds(orgId), { timeout: 30_000 }).toBe(0);
		const rows = await ledgerByModel(orgId);
		const served = rows.filter((r) => r.model !== null);
		expect(served.length, "the ledger recorded at least one model").toBeGreaterThan(0);
		for (const r of served) {
			expect(r.costMicros, `${r.model} carries a cost`).toBeGreaterThan(0);
		}
	});
});
