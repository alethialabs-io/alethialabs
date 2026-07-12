// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: cross-tenant isolation for agent_identities (audit #6 IDOR). This table
// carries NO RLS backstop yet (deferred to a later wave), so the ONLY thing stopping one
// org from reading another org's agent persona/mission is the explicit org predicate in the
// read path — app/server/actions/agents.ts (getAgent/listAgents) and the agent-scoped chat
// route (POST /api/agent/[agentId]). This proves that predicate is load-bearing: seeded via
// the service connection (bypasses RLS), read back through the real code under an INJECTED
// actor (the same runWithActor seam the MCP server uses), so the actions/route run unchanged
// under the test identity.
//
// Pre-fix (org-blind select, no predicate) these assertions FAIL: getAgent(orgB.id) returns
// org B's row, listAgents() returns both, and the route streams org B's persona. Post-fix they
// all resolve to nothing / 404 for a cross-tenant id, and org A still sees its own agent.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getAgent, listAgents } from "@/app/server/actions/agents";
import { POST } from "@/app/api/agent/[agentId]/route";
import { runWithActor } from "@/lib/authz/actor-context";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { agentIdentities } from "@/lib/db/schema";
import { describeIfDb } from "./db";

// Community tenancy model: orgId === userId (personal org).
const ORG_A = randomUUID();
const ORG_B = randomUUID();

// Distinct persona/mission per tenant — the payload the IDOR would leak.
const A_PERSONA = `persona-a-${ORG_A.slice(0, 8)}`;
const B_PERSONA = `persona-b-${ORG_B.slice(0, 8)}`;
const B_MISSION = `mission-b-${ORG_B.slice(0, 8)}`;

let agentAId = "";
let agentBId = "";

/** An injected actor for `orgId` in the community model (orgId === userId). */
function actorFor(orgId: string): Actor {
	return { userId: orgId, orgId };
}

describeIfDb("agent_identities cross-tenant isolation (IDOR audit #6)", () => {
	beforeAll(async () => {
		// The route reaches isAiConfigured() before the 404; a dummy key makes it pass so a
		// cross-tenant id returns 404 (isolation) rather than 503 (unconfigured). Cross-tenant
		// requests never reach the model, so no real provider call is made.
		process.env.ANTHROPIC_API_KEY ||= "sk-integration-test-not-used";

		const db = getServiceDb();
		const [a] = await db
			.insert(agentIdentities)
			.values({
				user_id: ORG_A,
				org_id: ORG_A,
				persona: A_PERSONA,
				mission: `mission-a-${ORG_A.slice(0, 8)}`,
				tool_scope: [],
				memory_namespace: `org/${ORG_A}`,
			})
			.returning({ id: agentIdentities.id });
		agentAId = a.id;

		const [b] = await db
			.insert(agentIdentities)
			.values({
				user_id: ORG_B,
				org_id: ORG_B,
				persona: B_PERSONA,
				mission: B_MISSION,
				tool_scope: [],
				memory_namespace: `org/${ORG_B}`,
			})
			.returning({ id: agentIdentities.id });
		agentBId = b.id;
	});

	afterAll(async () => {
		await getServiceDb()
			.delete(agentIdentities)
			.where(inArray(agentIdentities.org_id, [ORG_A, ORG_B]));
	});

	// Sanity: the service connection (RLS bypassed) sees both — the rows really exist, so a
	// null cross-tenant read below is the predicate working, not a missing seed.
	it("the service connection sees both orgs' agents", async () => {
		const rows = await getServiceDb()
			.select()
			.from(agentIdentities)
			.where(inArray(agentIdentities.org_id, [ORG_A, ORG_B]));
		expect(rows).toHaveLength(2);
	});

	// ── getAgent: the IDOR itself ──────────────────────────────────────────────
	it("org A cannot read org B's agent by id (getAgent → null)", async () => {
		const leaked = await runWithActor(actorFor(ORG_A), () => getAgent(agentBId));
		expect(leaked).toBeNull();
	});

	it("org A CAN read its own agent (non-vacuity)", async () => {
		const own = await runWithActor(actorFor(ORG_A), () => getAgent(agentAId));
		expect(own?.id).toBe(agentAId);
		expect(own?.persona).toBe(A_PERSONA);
	});

	// ── listAgents: the enumeration leak ───────────────────────────────────────
	it("listAgents returns only the caller's org agents (never org B's)", async () => {
		const forA = await runWithActor(actorFor(ORG_A), () => listAgents());
		expect(forA.map((r) => r.id)).toEqual([agentAId]);

		const forB = await runWithActor(actorFor(ORG_B), () => listAgents());
		expect(forB.map((r) => r.id)).toEqual([agentBId]);
	});

	// ── the chat route: the reachable entrypoint ───────────────────────────────
	it("POST /api/agent/[agentId] returns 404 for another org's agent (no persona leak)", async () => {
		const res = await runWithActor(actorFor(ORG_A), () =>
			POST(new Request("http://localhost/api/agent", { method: "POST" }), {
				params: Promise.resolve({ agentId: agentBId }),
			}),
		);
		expect(res.status).toBe(404);
		const body = await res.text();
		expect(body).not.toContain(B_PERSONA);
		expect(body).not.toContain(B_MISSION);
	});
});
