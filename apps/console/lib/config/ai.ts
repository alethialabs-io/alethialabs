// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { env } from "next-runtime-env";
import type { AiTier } from "@/lib/billing/ai-plan";

export interface AiModel {
	/** AI Gateway `provider/model` id. */
	id: string;
	name: string;
	provider: string;
}

/**
 * Curated, user-selectable models (the agent model picker). An allowlist so a
 * client-supplied `model` can't inject an arbitrary gateway id. Index 0 is the
 * default. Verified against the gateway model list (Jun 2026).
 */
export const AI_MODELS: AiModel[] = [
	{ id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", provider: "anthropic" },
	{ id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", provider: "anthropic" },
];

const ALLOWED_MODELS = new Set(AI_MODELS.map((m) => m.id));

/**
 * Resolve the model for an assistant request, via the Vercel AI Gateway
 * (`provider/model` string). A client `override` wins only if it's in the
 * allowlist; otherwise env `AI_MODEL`, then the default (Haiku 4.5 — the cheapest
 * tool-capable model; Sonnet 4.6 is the opt-in upgrade).
 */
export function getAiModel(override?: string): string {
	if (override && ALLOWED_MODELS.has(override)) return override;
	return env("AI_MODEL") || AI_MODELS[0].id;
}

/** Whether `id` is a selectable model — i.e. a deliberate client-picker choice (allowlist). */
export function isSelectableModel(id: string | undefined | null): id is string {
	return Boolean(id && ALLOWED_MODELS.has(id));
}

/**
 * The cheap **executor** model that runs the agent tool loop — the cost-optimized default
 * that does most of the tokens. Haiku 4.5 (priced in lib/billing/model-costs.ts via C0).
 */
export function getExecutorModel(): string {
	return "anthropic/claude-haiku-4.5";
}

/**
 * The **advisor** (planning/review) model for an org's AI tier: Sonnet 4.6 on `ai_plus`,
 * Opus 4.8 on `ai_max`, and the executor (Haiku — i.e. NO distinct advisor) on `ai_free`.
 * The agent's step 0 (planning) runs on the advisor; the tool loop runs on the executor.
 */
export function getAdvisorModel(tier: AiTier): string {
	if (tier === "ai_max") return "anthropic/claude-opus-4.8";
	if (tier === "ai_plus") return "anthropic/claude-sonnet-4.6";
	return getExecutorModel();
}

/**
 * Whether the AI layer is configured. The AI Gateway provider reads
 * AI_GATEWAY_API_KEY (or Vercel OIDC) server-side; without it the assistant route
 * returns 503 and the UI shows a "not configured" state. Self-hosters set this key
 * to enable the `ee/` AI tier.
 */
export function isAiConfigured(): boolean {
	return Boolean(env("AI_GATEWAY_API_KEY") || env("VERCEL_OIDC_TOKEN"));
}
