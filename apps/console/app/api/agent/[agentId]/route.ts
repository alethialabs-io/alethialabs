// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { UIMessage } from "ai";
import { and, eq, or } from "drizzle-orm";
import { z } from "zod";
import { buildAgentSystemPrompt, scopeToolsToAgent } from "@/lib/agent/executor";
import { readTurnRequest, serveTurnBody } from "@/lib/agent/turn-route";
import { type AgentMode, buildAgentTools } from "@/lib/ai/tools";
import type { Actor } from "@/lib/authz/types";
import { getAiModel } from "@/lib/config/ai";
import { withScope } from "@/lib/db";
import { agentIdentities } from "@/lib/db/schema";

// Node runtime: the tools reach postgres-js + the actor seam uses AsyncLocalStorage.
export const runtime = "nodejs";

/** The agent route's own body fields. `threadId` is checked as a uuid by the claimed route body. */
const agentIdentityBodySchema = z.looseObject({
	messages: z.array(z.custom<UIMessage>()),
	threadId: z.unknown().optional(),
	mode: z.enum(["ask", "act"]).optional(),
});

/** The agent route's own fields, as its check and `prepare` read them. */
interface AgentIdentityFields {
	agentId: string;
	mode: AgentMode;
}

/** The identity row the turn runs as. */
type AgentIdentity = typeof agentIdentities.$inferSelect;

/**
 * The agent identity `agentId` as `actor` may read it: its own user rows, or the actor's org's. An
 * agent id of another org resolves to nothing, so its persona and mission never enter a prompt.
 * `agent_identities` has no RLS backstop yet, so this explicit predicate is the enforcement point.
 */
async function readAgentIdentity(actor: Actor, agentId: string): Promise<AgentIdentity | null> {
	if (!z.uuid().safeParse(agentId).success) return null;
	return withScope({ ownerId: actor.userId, orgId: actor.orgId }, async (tx) => {
		const [a] = await tx
			.select()
			.from(agentIdentities)
			.where(
				and(
					eq(agentIdentities.id, agentId),
					or(
						eq(agentIdentities.user_id, actor.userId), // authz-scope-ok: agent_identities has no set_org_id trigger and a nullable org_id, so the user_id arm (a globally-unique id → no cross-tenant match) scopes the actor's OWN rows; the org_id arm scopes Teams. Both keys are the caller's.
						eq(agentIdentities.org_id, actor.orgId),
					),
				),
			)
			.limit(1);
		return a ?? null;
	});
}

/**
 * Agent-scoped chat turn (elench A3): run a turn AS a specific agent identity, on the turn claim (ADR
 * 0003 slice 8, Q11). The shared route body (`lib/agent/turn-route.ts`) resolves the billing
 * org from the request's `orgId` and the thread's pin, then this route looks the identity up under that
 * actor (a 404 before the hold for an id the actor cannot read), and the thread is the identity's
 * project's. The deterministic executor core (buildAgentSystemPrompt + scopeToolsToAgent) shapes the
 * prompt from the persona and mission and narrows the tools to its tool_scope; tools stay PDP-gated at
 * execute time, so no new authority.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ agentId: string }> },
): Promise<Response> {
	const request = await readTurnRequest(req, "AI is not configured.");
	if (!request.ok) return request.response;
	const { agentId } = await params;
	// The identity the route's check read for the attempt that is accepted: the check runs under each
	// attempt's actor (again when the thread's pin moved), and `prepare` runs after its attempt's check.
	let identity: AgentIdentity | null = null;

	return serveTurnBody<AgentIdentityFields>(req, request.userId, request.raw, {
		aiDisabledMessage: "AI is not configured.",
		projectId: null,
		threadKind: "agent",
		aiKind: "agent",
		parseBody: (raw) => {
			const parsed = agentIdentityBodySchema.safeParse(raw);
			if (!parsed.success) {
				const first = parsed.error.issues[0];
				return {
					ok: false,
					message: first ? `${first.path.join(".") || "body"}: ${first.message}` : "The request body is malformed.",
				};
			}
			return {
				ok: true,
				value: {
					messages: parsed.data.messages,
					threadId: parsed.data.threadId,
					route: { agentId, mode: parsed.data.mode ?? "ask" },
				},
			};
		},
		gate: async (actor, route) => {
			identity = await readAgentIdentity(actor, route.agentId);
			if (!identity) return { ok: false, response: new Response("Agent not found", { status: 404 }) };
			return { ok: true, projectId: identity.project_id };
		},
		prepare: async ({ route }) => {
			const agent = identity;
			if (!agent) throw new Error("the agent identity was not read before acceptance");
			const model = getAiModel();
			return {
				system: buildAgentSystemPrompt(agent),
				tools: scopeToolsToAgent(buildAgentTools({ mode: route.mode }), agent.tool_scope),
				// Single-model run: extended thinking on every step so reasoning streams.
				models: { advisor: model, executor: model, base: model, clientPick: true },
			};
		},
	});
}
