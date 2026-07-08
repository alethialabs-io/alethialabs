// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { env } from "next-runtime-env";

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

/**
 * Whether the AI layer is configured. The AI Gateway provider reads
 * AI_GATEWAY_API_KEY (or Vercel OIDC) server-side; without it the assistant route
 * returns 503 and the UI shows a "not configured" state. Self-hosters set this key
 * to enable the `ee/` AI tier.
 */
export function isAiConfigured(): boolean {
	return Boolean(env("AI_GATEWAY_API_KEY") || env("VERCEL_OIDC_TOKEN"));
}
