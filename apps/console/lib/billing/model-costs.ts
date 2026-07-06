// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Public per-model token pricing + cost math. Used to snapshot the USD cost of each
// metered AI action into the usage ledger (lib/billing/ai-quota.ts), so real AI
// cost-of-serve is queryable per org. Prices are provider list pricing — keep in
// sync with the models in lib/config/ai.ts.

/** Token prices in USD per million tokens. */
interface ModelPrice {
	inputPerMTok: number;
	outputPerMTok: number;
}

/** Cache reads bill at ~10% of the input price (Anthropic prompt caching). */
const CACHE_READ_MULTIPLIER = 0.1;

/** $/MTok by AI Gateway model id (the `provider/model` ids in lib/config/ai.ts). */
const MODEL_PRICES: Record<string, ModelPrice> = {
	"anthropic/claude-sonnet-4.6": { inputPerMTok: 3, outputPerMTok: 15 },
	"anthropic/claude-opus-4.8": { inputPerMTok: 5, outputPerMTok: 25 },
};

/** Fallback (Sonnet-tier) so an unknown model never silently costs $0. */
const DEFAULT_PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };

/** Token usage for one AI action (uncached input + cache-read input + output). */
export interface AiTokenUsage {
	model: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedInputTokens?: number;
}

/** Look up the $/MTok price for a gateway model id (falls back to Sonnet-tier). */
export function modelPrice(model: string): ModelPrice {
	return MODEL_PRICES[model] ?? DEFAULT_PRICE;
}

/**
 * USD cost of one AI action from its model + token usage. `inputTokens` is the
 * (uncached) input billed at full rate; `cachedInputTokens` is cache-read input
 * billed at the reduced rate; output bills at the output rate. Matches Anthropic's
 * separate uncached/cache-read token accounting.
 */
export function aiCostUsd(u: AiTokenUsage): number {
	const p = modelPrice(u.model);
	const input = u.inputTokens ?? 0;
	const cached = u.cachedInputTokens ?? 0;
	const output = u.outputTokens ?? 0;
	return (
		(input * p.inputPerMTok +
			cached * p.inputPerMTok * CACHE_READ_MULTIPLIER +
			output * p.outputPerMTok) /
		1_000_000
	);
}

/** Cost of one AI action in integer USD micros (1e-6 USD), for ledger storage. */
export function aiCostMicros(u: AiTokenUsage): number {
	return Math.round(aiCostUsd(u) * 1_000_000);
}
