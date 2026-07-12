// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	convertToModelMessages,
	stepCountIs,
	streamText,
	type ToolSet,
	type UIMessage,
} from "ai";
import { and, eq, or } from "drizzle-orm";
import { saveThreadMessages } from "@/app/server/actions/agent";
import { buildAgentSystemPrompt, scopeToolsToAgent } from "@/lib/agent/executor";
import { textToAiOutput, uiMessagesToAiInput } from "@/lib/ai/ai-observability";
import { cachedSystemMessage, thinkingOptions } from "@/lib/ai/provider-options";
import { type AgentMode, buildAgentTools } from "@/lib/ai/tools";
import { currentActor } from "@/lib/authz/guard";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";
import { withScope } from "@/lib/db";
import { agentIdentities } from "@/lib/db/schema";

// Node runtime: the tools reach postgres-js + the actor seam uses AsyncLocalStorage.
export const runtime = "nodejs";
export const maxDuration = 300;

interface AgentChatBody {
	messages: UIMessage[];
	mode?: AgentMode;
	/** When set, the full transcript is persisted to this thread on finish. */
	threadId?: string;
}

/**
 * Agent-scoped chat turn (elench A3): run a turn AS a specific agent identity. The
 * deterministic executor core (buildAgentSystemPrompt + scopeToolsToAgent — unit
 * tested) shapes the system prompt from the agent's persona/mission and narrows the
 * tool set to its tool_scope (least privilege per agent). The model call mirrors the
 * main /api/agent route; tools stay PDP-gated at execute time, so no new authority.
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ agentId: string }> },
): Promise<Response> {
	// Resolve the actor first so the agent lookup is scoped to the caller's tenancy.
	const actor = await currentActor().catch(() => null);
	if (!actor) return new Response("Unauthorized", { status: 401 });
	if (!isAiConfigured()) {
		return new Response("AI is not configured.", { status: 503 });
	}

	const { agentId } = await params;
	// Scope the lookup to the actor's tenancy (own user rows OR the active org's): an
	// agent id belonging to another org resolves to nothing → 404, so its persona/mission
	// never enters the system prompt. agent_identities has no RLS backstop yet, so this
	// explicit org predicate — not RLS — is the enforcement point (fixes the IDOR).
	const agent = await withScope(
		{ ownerId: actor.userId, orgId: actor.orgId },
		async (tx) => {
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
		},
	);
	if (!agent) return new Response("Agent not found", { status: 404 });

	const charge = await assertAiAllowed(actor.orgId, "agent", actor.userId).catch((e: unknown) => {
		if (e instanceof AiBudgetError) return e;
		throw e;
	});
	if (charge instanceof AiBudgetError) {
		return new Response(JSON.stringify({ error: charge.message }), {
			status: 402,
			headers: { "content-type": "application/json" },
		});
	}

	const { messages, mode = "ask", threadId }: AgentChatBody = await req.json();
	const model = getAiModel();
	const tools = scopeToolsToAgent(
		buildAgentTools({ mode }),
		agent.tool_scope,
	) as ToolSet;
	// LLM-observability enrichment (PostHog): the thread is the "session", the prompt is the input,
	// and the scoped tool set is what powers the Tools view. Latency is wall-clock around the stream.
	const sessionId = threadId ?? agentId;
	const aiInput = uiMessagesToAiInput(messages);
	const toolNames = Object.keys(tools);
	const startedAt = Date.now();

	const result = streamText({
		model: model.model,
		// Cache the (stable, per-agent) system prompt so repeated turns read it from cache.
		messages: [
			cachedSystemMessage(buildAgentSystemPrompt(agent)),
			...(await convertToModelMessages(messages)),
		],
		// Our own system prompt (cached) is intentionally a system message; user turns are
		// never system-role, so this is not a prompt-injection surface.
		allowSystemInMessages: true,
		tools,
		stopWhen: stepCountIs(8),
		// Single-model run — extended thinking on every step so reasoning streams.
		providerOptions: thinkingOptions(model),
		onFinish: ({ usage, text, finishReason }) => {
			void recordAiUsage({
				orgId: actor.orgId,
				userId: actor.userId,
				kind: "agent",
				// Metered → omit credits; settled from this row's real cost-of-serve.
				source: charge.source,
				refId: sessionId,
				model: model.key,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedInputTokens: usage.cachedInputTokens,
				latencyMs: Date.now() - startedAt,
				sessionId,
				input: aiInput,
				outputChoices: textToAiOutput(text),
				tools: toolNames,
				stopReason: finishReason,
				stream: true,
			});
		},
		onError: ({ error }) => {
			// Record the failed generation so it shows in PostHog's Errors view (no tokens on error).
			void recordAiUsage({
				orgId: actor.orgId,
				userId: actor.userId,
				kind: "agent",
				source: charge.source,
				refId: sessionId,
				model: model.key,
				latencyMs: Date.now() - startedAt,
				sessionId,
				input: aiInput,
				tools: toolNames,
				stream: true,
				isError: true,
				error: error instanceof Error ? error.message : String(error),
			});
		},
	});

	return result.toUIMessageStreamResponse({
		originalMessages: messages,
		onFinish: ({ messages }) => {
			if (threadId) void saveThreadMessages(threadId, messages);
		},
	});
}
