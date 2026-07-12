// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server-side analytics capture (posthog-node). Client instrumentation covers user-driven actions, but
// truth about revenue arrives asynchronously via Stripe webhooks — no browser is present — so those
// events are captured here. Gated on the same PostHog env as the browser SDK; with no key it no-ops, so
// the OSS/self-hosted build ships zero server telemetry. Events set the `organization` group so they line
// up with the client-side group() in the same PostHog project, and use the org owner's user id as the
// distinct_id (when known) so a person's client + server events stitch into one timeline.

import { PostHog } from "posthog-node";
import type { AnalyticsEvent } from "./events";
import type { AnalyticsProps } from "./track";

let client: PostHog | null | undefined;

/** Lazily builds the singleton PostHog server client, or null when analytics env is unset. */
function getClient(): PostHog | null {
	if (client !== undefined) return client;
	const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
	if (!key) {
		client = null;
		return client;
	}
	// The browser host may be the reverse-proxy path ("/ingest"); that's a browser-only rewrite, so
	// the server must talk to the real cloud host directly (a relative path isn't a valid ingest URL).
	const rawHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;
	const host =
		rawHost && rawHost.startsWith("http")
			? rawHost.replace(/\/$/, "")
			: "https://eu.i.posthog.com";
	// flushAt:1 → send on every capture (serverless has no long-lived process to batch across).
	client = new PostHog(key, { host, flushAt: 1, flushInterval: 0 });
	return client;
}

/**
 * Capture a server-side event, attached to the `organization` group so it segments with the client
 * funnels. `distinctId` should be the org owner's user id when available (stitches to their client
 * timeline); callers pass the org id as a fallback so the event still lands on the org group.
 * Best-effort and awaited-flush — never throws into the caller (a webhook must not fail on telemetry).
 */
export async function captureServer(
	distinctId: string,
	event: AnalyticsEvent,
	orgId: string,
	props?: AnalyticsProps,
): Promise<void> {
	const ph = getClient();
	if (!ph) return;
	try {
		ph.capture({
			distinctId,
			event,
			properties: { ...props },
			groups: { organization: orgId },
		});
		await ph.flush();
	} catch {
		/* analytics must never break a webhook */
	}
}

/** Report a server-side exception to PostHog Error tracking. Best-effort; never throws. */
export async function captureServerException(
	error: unknown,
	ctx?: { distinctId?: string; orgId?: string; props?: AnalyticsProps },
): Promise<void> {
	const ph = getClient();
	if (!ph) return;
	try {
		ph.captureException(
			error,
			ctx?.distinctId,
			ctx?.orgId ? { $groups: { organization: ctx.orgId }, ...ctx?.props } : ctx?.props,
		);
		await ph.flush();
	} catch {
		/* telemetry must never break the caller */
	}
}

/** One LLM message ({role, content}) in PostHog's `$ai_input` / `$ai_output_choices` shape. */
export interface AiMessage {
	role: string;
	content: string;
}

// Cap the content we ship so a long thread can't blow past PostHog's per-event size limit.
const AI_CONTENT_MAX_CHARS = 8_000;
const AI_MESSAGES_MAX = 40;

/** Truncate a message array (count + per-message content) so the event stays well under the size cap. */
export function truncateAiMessages(messages: AiMessage[]): AiMessage[] {
	const capped = messages.slice(-AI_MESSAGES_MAX);
	return capped.map((m) => ({
		role: m.role,
		content:
			m.content.length > AI_CONTENT_MAX_CHARS
				? `${m.content.slice(0, AI_CONTENT_MAX_CHARS)}… [truncated ${m.content.length - AI_CONTENT_MAX_CHARS} chars]`
				: m.content,
	}));
}

/** Fields for one LLM generation (mirrors recordAiUsage — the single AI chokepoint). */
export interface AiGenerationInput {
	userId: string;
	orgId: string;
	kind: string;
	model?: string;
	refId?: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
	/** Anthropic cache-write tokens (separate from cache reads). */
	cacheCreationInputTokens?: number;
	costMicros?: number | null;
	latencyMs?: number;
	/** Conversation/thread id — groups a thread's turns into one PostHog LLM "session". */
	sessionId?: string;
	/** Prompt messages — powers the Traces conversation view + Sentiment. */
	input?: AiMessage[];
	/** Model output messages. */
	outputChoices?: AiMessage[];
	/** Tool names available to (or used by) this generation — powers the Tools view. */
	tools?: string[];
	/** True when the generation errored (powers the Errors view). */
	isError?: boolean;
	/** Error message when `isError`. */
	error?: string;
	/** Why the model stopped (end_turn, tool_use, max_tokens, …). */
	stopReason?: string;
	/** Whether the response was streamed. */
	stream?: boolean;
	temperature?: number;
	maxTokens?: number;
}

/**
 * Emit PostHog's reserved `$ai_generation` event so the LLM-analytics product (cost/tokens/latency by
 * model, org, feature, plus Traces/Sessions/Tools/Errors/Sentiment) lights up. Uses the `$ai_*` property
 * convention. distinct_id = the acting user so these stitch to their client timeline; attached to the org
 * group. Content ($ai_input/$ai_output_choices) is truncated to stay under PostHog's event size cap.
 * Best-effort; never throws.
 */
export async function captureAiGeneration(input: AiGenerationInput): Promise<void> {
	const ph = getClient();
	if (!ph) return;
	try {
		ph.capture({
			distinctId: input.userId,
			event: "$ai_generation",
			properties: {
				// Derive the provider from the canonical `provider/native-id` model key.
				$ai_provider: input.model ? input.model.split("/")[0] : undefined,
				$ai_model: input.model,
				$ai_input_tokens: input.inputTokens,
				$ai_output_tokens: input.outputTokens,
				$ai_cache_read_input_tokens: input.cachedInputTokens,
				$ai_cache_creation_input_tokens: input.cacheCreationInputTokens,
				$ai_total_cost_usd:
					input.costMicros != null ? input.costMicros / 1_000_000 : undefined,
				$ai_latency: input.latencyMs != null ? input.latencyMs / 1000 : undefined,
				$ai_trace_id: input.refId,
				$ai_session_id: input.sessionId,
				$ai_span_name: input.kind,
				$ai_input: input.input ? truncateAiMessages(input.input) : undefined,
				$ai_output_choices: input.outputChoices
					? truncateAiMessages(input.outputChoices)
					: undefined,
				$ai_tools: input.tools?.length ? input.tools : undefined,
				$ai_is_error: input.isError,
				$ai_error: input.error,
				$ai_stop_reason: input.stopReason,
				$ai_stream: input.stream,
				$ai_temperature: input.temperature,
				$ai_max_tokens: input.maxTokens,
			},
			groups: { organization: input.orgId },
		});
		await ph.flush();
	} catch {
		/* telemetry must never break an LLM call */
	}
}
