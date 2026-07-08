// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	convertToModelMessages,
	stepCountIs,
	streamText,
	type UIMessage,
} from "ai";
import { saveThreadMessages } from "@/app/server/actions/agent";
import { cachedSystemMessage } from "@/lib/ai/provider-options";
import { supportSystemPrompt } from "@/lib/ai/support/prompt";
import { buildSupportTools } from "@/lib/ai/tools/support";
import { getOwner } from "@/lib/auth/owner";
import { currentActor } from "@/lib/authz/guard";
import { AiBudgetError, assertAiAllowed } from "@/lib/billing/ai-guard";
import { recordAiUsage } from "@/lib/billing/ai-quota";
import { getAiModel, isAiConfigured } from "@/lib/config/ai";

interface SupportAskBody {
	messages: UIMessage[];
	/** When set, the full transcript is persisted to this (kind:"support") thread. */
	threadId?: string;
	/** Selected model id (validated against the allowlist). */
	model?: string;
}

/**
 * The Ask-AI support surface's streaming route — the same shape as the general agent
 * route (getOwner → isAiConfigured → currentActor → assertAiAllowed → streamText →
 * toUIMessageStreamResponse), swapping in the support persona + tool set and metering
 * under the `"support"` usage kind. Read-only tools + one HITL `create_support_case`
 * proposal; the 402-on-budget behavior is identical.
 */
export async function POST(req: Request) {
	const owner = await getOwner();
	if (!owner) return new Response("Unauthorized", { status: 401 });
	if (!isAiConfigured()) {
		return new Response(
			"AI is not configured. Set ANTHROPIC_API_KEY to enable the assistant.",
			{ status: 503 },
		);
	}

	const actor = await currentActor();
	const charge = await assertAiAllowed(actor.orgId, "support", actor.userId).catch(
		(e: unknown) => {
			if (e instanceof AiBudgetError) return e;
			throw e;
		},
	);
	if (charge instanceof AiBudgetError) {
		return new Response(
			JSON.stringify({
				error: charge.message,
				reason: charge.reason,
				resetAt: charge.resetAt,
				upgradable: charge.upgradable,
			}),
			{ status: 402, headers: { "content-type": "application/json" } },
		);
	}

	const { messages, threadId, model }: SupportAskBody = await req.json();
	const resolved = getAiModel(model);

	const result = streamText({
		model: resolved.model,
		// Cache the (stable) support persona so repeated turns read it from cache.
		messages: [
			cachedSystemMessage(supportSystemPrompt()),
			...(await convertToModelMessages(messages)),
		],
		// Our own system prompt (cached) is intentionally a system message; user turns are
		// never system-role, so this is not a prompt-injection surface.
		allowSystemInMessages: true,
		tools: buildSupportTools(),
		stopWhen: stepCountIs(8),
		// Record once the run completes, with the real token usage for cost-of-serve.
		onFinish: ({ usage }) => {
			void recordAiUsage({
				orgId: actor.orgId,
				userId: actor.userId,
				kind: "support",
				credits: charge.credits,
				source: charge.source,
				refId: threadId,
				model: resolved.key,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedInputTokens: usage.cachedInputTokens,
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
