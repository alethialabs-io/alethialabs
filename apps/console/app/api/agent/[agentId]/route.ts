// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	convertToModelMessages,
	stepCountIs,
	streamText,
	type ToolSet,
	type UIMessage,
} from "ai";
import { eq } from "drizzle-orm";
import { buildAgentSystemPrompt, scopeToolsToAgent } from "@/lib/agent/executor";
import { type AgentMode, buildAgentTools } from "@/lib/ai/tools";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";
import { withOwnerScope } from "@/lib/db";
import { agentIdentities } from "@/lib/db/schema";

// Node runtime: the tools reach postgres-js + the actor seam uses AsyncLocalStorage.
export const runtime = "nodejs";
export const maxDuration = 300;

interface AgentChatBody {
	messages: UIMessage[];
	mode?: AgentMode;
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
	const owner = await getOwner();
	if (!owner) return new Response("Unauthorized", { status: 401 });
	if (!isAiConfigured()) {
		return new Response("AI is not configured.", { status: 503 });
	}

	const { agentId } = await params;
	const agent = await withOwnerScope(owner, async (tx) => {
		const [a] = await tx
			.select()
			.from(agentIdentities)
			.where(eq(agentIdentities.id, agentId))
			.limit(1);
		return a ?? null;
	});
	if (!agent) return new Response("Agent not found", { status: 404 });

	const actor = await currentActor();
	const charge = await assertAiAllowed(actor.orgId, "agent").catch((e: unknown) => {
		if (e instanceof AiBudgetError) return e;
		throw e;
	});
	if (charge instanceof AiBudgetError) {
		return new Response(JSON.stringify({ error: charge.message }), {
			status: 402,
			headers: { "content-type": "application/json" },
		});
	}

	const { messages, mode = "ask" }: AgentChatBody = await req.json();
	const modelId = getAiModel();
	const tools = scopeToolsToAgent(
		buildAgentTools({ mode }),
		agent.tool_scope,
	) as ToolSet;

	const result = streamText({
		model: modelId,
		system: buildAgentSystemPrompt(agent),
		messages: await convertToModelMessages(messages),
		tools,
		stopWhen: stepCountIs(8),
		onFinish: ({ usage }) => {
			void recordAiUsage({
				orgId: actor.orgId,
				userId: actor.userId,
				kind: "agent",
				credits: charge.credits,
				source: charge.source,
				refId: agentId,
				model: modelId,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedInputTokens: usage.cachedInputTokens,
			});
		},
	});

	return result.toUIMessageStreamResponse({ originalMessages: messages });
}
