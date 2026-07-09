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
	costMicros?: number | null;
	latencyMs?: number;
}

/**
 * Emit PostHog's reserved `$ai_generation` event so the LLM-analytics product (cost/tokens/latency by
 * model, org, feature) lights up. Uses the `$ai_*` property convention. distinct_id = the acting user so
 * these stitch to their client timeline; attached to the org group. Best-effort; never throws.
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
				$ai_total_cost_usd:
					input.costMicros != null ? input.costMicros / 1_000_000 : undefined,
				$ai_latency: input.latencyMs != null ? input.latencyMs / 1000 : undefined,
				$ai_trace_id: input.refId,
				$ai_span_name: input.kind,
			},
			groups: { organization: input.orgId },
		});
		await ph.flush();
	} catch {
		/* telemetry must never break an LLM call */
	}
}
