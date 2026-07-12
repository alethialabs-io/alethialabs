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
import {
	AiBudgetError,
	type AiHoldContext,
	assertAiAllowed,
	releaseAiHold,
} from "@/lib/billing/ai-guard";
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

	// Everything from here through the streamText registration runs AFTER the hold was reserved. A
	// throw in this window (req parsing, model resolution, message conversion) would strand the
	// ≈$0.10 hold — nothing downstream releases it — so release it in the catch. `holdCtx.refId` is
	// filled once `threadId` is known; a throw in `req.json()` leaves it undefined (harmless).
	const holdCtx: AiHoldContext = {
		orgId: actor.orgId,
		userId: actor.userId,
		kind: "support",
	};
	try {
		const { messages, threadId, model }: SupportAskBody = await req.json();
		holdCtx.refId = threadId;
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
			// Wire the request's abort signal so a client disconnect aborts generation (and fires
			// onAbort) instead of streaming — and paying — into the void with the hold left open.
			abortSignal: req.signal,
			tools: buildSupportTools(),
			stopWhen: stepCountIs(8),
			// Record once the run completes, with the real token usage for cost-of-serve. Reconciles the
			// reserved hold IN PLACE (holdId) so the provisional estimate becomes the turn's real cost.
			onFinish: ({ usage }) => {
				void recordAiUsage({
					orgId: actor.orgId,
					userId: actor.userId,
					kind: "support",
					// Metered → omit credits; settled from this row's real cost-of-serve.
					source: charge.source,
					holdId: charge.settle ? charge.holdId : undefined,
					refId: threadId,
					model: resolved.key,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cachedInputTokens: usage.cachedInputTokens,
				});
			},
			// A failed turn RELEASES its reserved hold (reconciled to 0) so it never leaks headroom.
			onError: ({ error }) => {
				void recordAiUsage({
					orgId: actor.orgId,
					userId: actor.userId,
					kind: "support",
					source: charge.source,
					holdId: charge.settle ? charge.holdId : undefined,
					refId: threadId,
					model: resolved.key,
					isError: true,
					error: error instanceof Error ? error.message : String(error),
				});
			},
			// Client disconnect mid-stream: onFinish/onError won't fire, so RELEASE the hold here
			// (mutually exclusive with them) — otherwise an abandoned turn leaks its ≈$0.10 hold.
			onAbort: () => {
				void releaseAiHold(charge, holdCtx);
			},
		});

		return result.toUIMessageStreamResponse({
			originalMessages: messages,
			onFinish: ({ messages }) => {
				if (threadId) void saveThreadMessages(threadId, messages);
			},
		});
	} catch (e) {
		// A throw between the gate and stream registration strands the hold — release it before rethrow.
		await releaseAiHold(charge, holdCtx);
		throw e;
	}
}
