// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server-side product analytics is intentionally disabled. A background job or webhook cannot prove
// the browser user's current consent, so forwarding user- or organization-linked events would bypass
// the consent gate. Consent-aware client instrumentation remains available; operational logging stays
// inside Alethia's service boundary.

import type { AnalyticsEvent } from "./events";
import type { AnalyticsProps } from "./track";

/**
 * Preserve the analytics call contract while declining background capture. Server contexts cannot
 * establish an end user's current optional-telemetry consent.
 */
export async function captureServer(
	distinctId: string,
	event: AnalyticsEvent,
	orgId: string,
	props?: AnalyticsProps,
): Promise<void> {
	void distinctId;
	void event;
	void orgId;
	void props;
}

/** Keep caught server exceptions inside operational logs, not third-party product analytics. */
export async function captureServerException(
	error: unknown,
	ctx?: { distinctId?: string; orgId?: string; props?: AnalyticsProps },
): Promise<void> {
	void error;
	void ctx;
}

/** One LLM message accepted by the existing metering call contract. */
export interface AiMessage {
	role: string;
	content: string;
}

/** Existing fields for one LLM generation (mirrors recordAiUsage — the metering chokepoint). */
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
	/** Conversation/thread id. */
	sessionId?: string;
	/** Prompt messages. These are intentionally not forwarded to third-party analytics. */
	input?: AiMessage[];
	/** Model output messages. These are intentionally not forwarded to third-party analytics. */
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
 * Decline third-party AI-generation capture. Prompts, outputs, tool names, errors, and account-linked
 * usage remain inside the service boundary until a consent-aware server event path exists.
 */
export async function captureAiGeneration(input: AiGenerationInput): Promise<void> {
	void input;
}
