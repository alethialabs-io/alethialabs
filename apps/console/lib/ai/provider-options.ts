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
 * Anthropic extended-thinking options for a resolved model, so reasoning parts actually
 * stream to the transcript: adaptive thinking (the Sonnet 4.6 / Opus 4.8 mode) for
 * Anthropic models, a small fixed budget for Haiku (which doesn't support adaptive),
 * undefined for non-Anthropic providers. Attach on the planning step via `prepareStep`
 * (every tier — the free tier's Haiku advisor thinks too) and top-level on single-model
 * runs (explicit client pick, agent-identity route). Thinking tokens bill as output
 * tokens, so the per-step usage ledger needs no change.
 */
export function thinkingOptions(
	model: ResolvedModel,
): ProviderOptionsBag | undefined {
	if (model.provider !== "anthropic") return undefined;
	// Haiku rejects `adaptive` — give it a bounded fixed budget instead.
	if (model.key.includes("haiku")) {
		return { anthropic: { thinking: { type: "enabled", budgetTokens: 3072 } } };
	}
	return { anthropic: { thinking: { type: "adaptive" } } };
}
