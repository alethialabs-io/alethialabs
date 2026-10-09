// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the shared Elench route body (`lib/agent/turn-route.ts`, ADR 0003 slice 6)
// over the REAL claim state machine (`reserveTurn`, `finalizeTurn`) and the real ledger. The R tests in
// `tests/api/agent-turn-routes.test.ts` drive the route over an in-memory fake; this file asks the
// database the one question the fake cannot answer: an accepted turn, streamed and finalized, leaves
// exactly one settled ledger row, one answered claim and the stored answer, and a duplicate of the turn
// reserves nothing more.
//
// Mocked: the session (`getOwner`), the org resolver (the personal org), the model (ai's mock model),
// the tool set and the prompt's context reads. Everything that writes is real.
//
// Needs a migrated Postgres on ALETHIA_DATABASE_URL (CI's Integration job); skips when unreachable.

import { randomUUID } from "node:crypto";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const session = vi.hoisted((): { user: string | null } => ({ user: null }));

vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn(async () => session.user) }));
vi.mock("@/lib/authz/guard", () => ({
	resolveTurnActor: vi.fn(async (userId: string, orgId: string) => (orgId === userId ? { userId, orgId } : null)),
}));
vi.mock("@/lib/billing/ai-spend-alert", () => ({ checkAiSpendThreshold: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/billing/ai-plan", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/ai-plan")>()),
	resolveAiTier: vi.fn(async () => "ai_free"),
}));
vi.mock("@/lib/ai/project-knowledge", () => ({
	buildProjectKnowledge: vi.fn(async () => ""),
	formatContextBlock: vi.fn(() => ""),
	readAgentContext: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/tools", () => ({ buildAgentTools: () => ({}), buildProjectAgentTools: () => ({}) }));
vi.mock("@/lib/config/ai", async () => {
	const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
	const usage = {
		inputTokens: { total: 1200, noCache: 1200, cacheRead: 0, cacheWrite: 0 },
		outputTokens: { total: 600, text: 600, reasoning: 0 },
	};
	const chunks: LanguageModelV3StreamPart[] = [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: "Nothing failed." },
		{ type: "text-end", id: "t1" },
		{ type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
	];
	const model = new MockLanguageModelV3({
		provider: "anthropic",
		modelId: "claude-haiku-4-5",
		doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
	});
	const resolved = { model, key: "anthropic/claude-haiku-4-5", provider: "anthropic" as const };
	return {
		isAiConfigured: () => true,
		getExecutorModel: () => resolved,
		getAdvisorModel: () => resolved,
		resolveModel: () => resolved,
		isSelectableModel: () => false,
	};
});

import { POST } from "@/app/api/agent/route";
import { getServiceDb } from "@/lib/db";
import { agentThreads, agentTurnClaims, aiUsageLedger } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const users: string[] = [];

/** POST /api/agent with this body. */
async function post(body: unknown): Promise<Response> {
	return POST(new Request("https://console.local/api/agent", { method: "POST", body: JSON.stringify(body) }));
}

/** Read a streamed response to its end and return its raw text. */
async function drain(res: Response): Promise<string> {
	return res.text();
}

describeIfDb("the shared Elench route body over the real claim state machine (ADR 0003 slice 6)", () => {
	beforeAll(() => {
		// The hosted-billing path (isStripeConfigured() checks the key's presence).
		process.env.STRIPE_SECRET_KEY ||= "sk_test_agent_turn_route_integration";
	});

	afterAll(async () => {
		if (users.length === 0) return;
		const db = getServiceDb();
		await db.delete(agentTurnClaims).where(inArray(agentTurnClaims.user_id, users));
		await db.delete(agentThreads).where(inArray(agentThreads.user_id, users));
		await db.delete(aiUsageLedger).where(inArray(aiUsageLedger.org_id, users));
	});

	it("accept → stream → finalize: the answer stored, the claim answered, the hold settled exactly once; a duplicate reserves nothing", async () => {
		const user = randomUUID();
		users.push(user);
		session.user = user;
		const db = getServiceDb();
		const [thread] = await db
			.insert(agentThreads)
			.values({ user_id: user, org_id: user, title: "route integration", messages: [] })
			.returning({ id: agentThreads.id });
		const u: UIMessage = { id: `u-${randomUUID()}`, role: "user", parts: [{ type: "text", text: "what failed?" }] };
		const body = {
			messages: [u],
			threadId: thread.id,
			orgId: user,
			mode: "ask",
			turn: { trigger: "submit-message", turnId: u.id, baseRevision: 1 },
		};

		const res = await post(body);
		expect(res.status).toBe(200);
		const text = await drain(res);
		expect(text).toContain("data-turn-accepted");
		expect(text.indexOf("data-turn-finished")).toBeLessThan(text.indexOf('"type":"finish"'));

		const [row] = await db.select().from(agentThreads).where(eq(agentThreads.id, thread.id));
		expect(row.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(JSON.stringify(row.messages[1])).toContain("Nothing failed.");
		expect(row.billing_org_id).toBe(user);
		expect(row.revision).toBe(3);

		const claimRows = await db.select().from(agentTurnClaims).where(eq(agentTurnClaims.thread_id, thread.id));
		expect(claimRows).toHaveLength(1);
		expect(claimRows[0]).toMatchObject({ state: "answered", partial: false, billing_org_id: user });

		const ledger = await db.select().from(aiUsageLedger).where(eq(aiUsageLedger.org_id, user));
		expect(ledger).toHaveLength(1);
		expect(ledger[0]?.id).toBe(claimRows[0]?.hold_id);
		expect(ledger[0]?.settled_at).not.toBeNull();
		expect(ledger[0]?.credits).toBeGreaterThan(0);

		// The same turn again (a duplicated tab's Retry): refused before the hold.
		const again = await post({ ...body, turn: { ...body.turn, trigger: "regenerate-message", baseRevision: 3 } });
		expect(again.status).toBe(409);
		expect(await again.json()).toMatchObject({ refusal: "turn-answered", committed: true });
		expect(await db.select().from(aiUsageLedger).where(eq(aiUsageLedger.org_id, user))).toHaveLength(1);
	});
});
