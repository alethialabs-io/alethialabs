// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	convertToModelMessages,
	stepCountIs,
	streamText,
	type UIMessage,
} from "ai";
import { z } from "zod";
import { readTurnRequest, serveTurnBody } from "@/lib/agent/turn-route";
import { cachedSystemMessage } from "@/lib/ai/provider-options";
import { supportSystemPrompt } from "@/lib/ai/support/prompt";
import { buildSupportTools } from "@/lib/ai/tools/support";
import { currentActor } from "@/lib/authz/guard";
import {
	AiBudgetError,
	type AiHoldContext,
	assertAiAllowed,
	releaseAiHold,
} from "@/lib/billing/ai-guard";
import { meteringFailed, recordAiUsage } from "@/lib/billing/ai-quota";
import { getAiModel } from "@/lib/config/ai";
import { holdRequest } from "@/lib/http/hold-request";

/** The support chat's own body fields: its messages and the user's model pick. */
const supportBodySchema = z.looseObject({
	messages: z.array(z.custom<UIMessage>()),
	threadId: z.unknown().optional(),
	/** Selected model id (validated against the allowlist by `getAiModel`). */
	model: z.string().optional().catch(undefined),
});

/** The support route's own fields, as the claimed path's `prepare` reads them. */
interface SupportRouteFields {
	model: string | undefined;
}

const AI_DISABLED = "AI is not configured. Set ANTHROPIC_API_KEY to enable the assistant.";

/**
 * POST /api/support/ask — one Ask-AI support turn: the support persona, the read-only tools and one HITL
 * `create_support_case` proposal, metered under the `"support"` usage kind.
 *
 * A request that names a thread runs on the turn claim (ADR 0003 slice 8, Q11): the shared route
 * body (`lib/agent/turn-route.ts`) resolves the org, reserves one hold per turn inside `reserveTurn`,
 * and finalizes before `finish`. A missing support thread is `thread-not-found`; it is
 * never recreated. A request with no `threadId` (what the console's support chat sends) keeps the
 * per-request hold below (§12): it has no transcript to claim against.
 */
export async function POST(req: Request): Promise<Response> {
	const request = await readTurnRequest(req, AI_DISABLED);
	if (!request.ok) return request.response;
	const { userId, raw } = request;
	const threadId = "threadId" in raw ? raw.threadId : undefined;
	if (threadId === undefined || threadId === null) return answerThreadless(req, raw);

	return serveTurnBody<SupportRouteFields>(req, userId, raw, {
		aiDisabledMessage: AI_DISABLED,
		// A support thread is an org thread of its user: no project, and no check of the route's own.
		projectId: null,
		threadKind: "support",
		aiKind: "support",
		parseBody: (body) => {
			const parsed = supportBodySchema.safeParse(body);
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
					mentions: undefined,
					cellTarget: null,
					route: { model: parsed.data.model },
				},
			};
		},
		// One model on every step and no extended thinking, as the threadless path runs it.
		prepare: async ({ route }) => {
			const model = getAiModel(route.model);
			return {
				system: supportSystemPrompt(),
				tools: buildSupportTools(),
				models: { advisor: model, executor: model, base: model, clientPick: true, thinking: false },
			};
		},
	});
}

/**
 * A support turn that names no thread: the per-request hold, as before ADR 0003 (§12). The org is the
 * session's, the hold is reserved by `assertAiAllowed`, settled from `onFinish`, released by `onError`
 * and `onAbort`, and nothing is stored. The three callbacks also keep `req` reachable until the model's
 * stream ends, so a client's disconnect still aborts the model after a GC (#5817).
 */
async function answerThreadless(req: Request, raw: object): Promise<Response> {
	const parsed = supportBodySchema.safeParse(raw);
	if (!parsed.success) return new Response("The request body is malformed.", { status: 400 });
	const { messages, model } = parsed.data;

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
	// throw in this window (model resolution, message conversion) would strand the ≈$0.10 hold —
	// nothing downstream releases it — so release it in the catch. A threadless turn has no `refId`.
	const holdCtx: AiHoldContext = {
		orgId: actor.orgId,
		userId: actor.userId,
		kind: "support",
	};
	try {
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
				holdRequest(req);
				void recordAiUsage({
					orgId: actor.orgId,
					userId: actor.userId,
					kind: "support",
					// Metered → omit credits; settled from this row's real cost-of-serve.
					source: charge.source,
					holdId: charge.settle ? charge.holdId : undefined,
					model: resolved.key,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cachedInputTokens: usage.cachedInputTokens,
				}).catch(meteringFailed(actor.orgId));
			},
			// A failed turn RELEASES its reserved hold (reconciled to 0) so it never leaks headroom.
			onError: ({ error }) => {
				holdRequest(req);
				void recordAiUsage({
					orgId: actor.orgId,
					userId: actor.userId,
					kind: "support",
					source: charge.source,
					holdId: charge.settle ? charge.holdId : undefined,
					model: resolved.key,
					isError: true,
					error: error instanceof Error ? error.message : String(error),
				}).catch(meteringFailed(actor.orgId));
			},
			// Client disconnect mid-stream: onFinish/onError won't fire, so RELEASE the hold here
			// (mutually exclusive with them) — otherwise an abandoned turn leaks its ≈$0.10 hold.
			onAbort: () => {
				holdRequest(req);
				void releaseAiHold(charge, holdCtx);
			},
		});

		return result.toUIMessageStreamResponse({ originalMessages: messages });
	} catch (e) {
		// A throw between the gate and stream registration strands the hold — release it before rethrow.
		await releaseAiHold(charge, holdCtx);
		throw e;
	}
}
