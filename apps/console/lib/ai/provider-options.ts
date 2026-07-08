// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { JSONValue, ModelMessage } from "ai";
import type { ResolvedModel } from "@/lib/config/ai";

// Anthropic-native `providerOptions` for the direct-provider path (no gateway): extended
// thinking on the advisor step and prompt caching on the stable system prompt. Both are
// namespaced under `anthropic`, so a non-Anthropic provider (e.g. an OpenAI executor)
// silently ignores them — safe to attach unconditionally on cross-provider calls.

/**
 * Provider options bag (the AI SDK's `SharedV3ProviderOptions` shape: provider →
 * option map). Kept structural (index-signatured) so it slots into `streamText` /
 * `prepareStep`'s `providerOptions` without a cast.
 */
export type ProviderOptionsBag = Record<string, Record<string, JSONValue>>;

/**
 * Wrap a stable system prompt as a system message carrying an Anthropic prompt-caching
 * breakpoint. Anthropic caches the prompt prefix up to (and including) this block, so an
 * identical repeat turn reads it from cache — billed at ~10% and reported as
 * `cachedInputTokens` (the ledger's cache-read cost path already handles it). The
 * `cacheControl` option lives under the `anthropic` namespace, so other providers ignore it.
 */
export function cachedSystemMessage(system: string): ModelMessage {
	return {
		role: "system",
		content: system,
		providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
	};
}

/**
 * Provider options for the ADVISOR planning step: Anthropic adaptive extended thinking —
 * the current Sonnet 4.6 / Opus 4.8 thinking mode (adaptive, not a fixed token budget).
 * Returns undefined unless the advisor is a DISTINCT Anthropic model (so thinking is never
 * forced on the executor — including `ai_free`, where the advisor IS the Haiku executor —
 * nor on an OpenAI advisor). Attach only on step 0 via `prepareStep`.
 */
export function advisorThinkingOptions(
	advisor: ResolvedModel,
	executor: ResolvedModel,
): ProviderOptionsBag | undefined {
	if (advisor.provider !== "anthropic") return undefined;
	if (advisor.key === executor.key) return undefined;
	return { anthropic: { thinking: { type: "adaptive" } } };
}
