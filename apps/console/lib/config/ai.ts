// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createAnthropic, type AnthropicProvider } from "@ai-sdk/anthropic";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { env } from "next-runtime-env";
import type { AiTier } from "@/lib/billing/ai-plan";
import { isAiMock, mockLanguageModel } from "./ai-mock";

// Direct multi-provider model registry (no Vercel AI Gateway). A model is addressed by a
// canonical **key** `"provider/native-id"` (e.g. `anthropic/claude-haiku-4-5`); `resolveModel`
// parses the key, picks the matching `@ai-sdk/<provider>` instance, and returns both the SDK
// `LanguageModel` (passed to streamText/generateText/generateObject) and the key (used verbatim
// as the ledger / cost / analytics key). Each role is env-overridable in `provider/native-id`
// form, so swapping the executor (or an advisor tier) is a config flip, not a rebuild.

/** The providers wired directly (own API keys, no gateway). */
export type ProviderId = "anthropic" | "openai";

export interface AiModel {
	/** Canonical `provider/native-id` key (also the ledger/cost/analytics key). */
	id: string;
	name: string;
	provider: ProviderId;
}

/** Default role keys (native provider ids), each overridable via env. */
const DEFAULT_EXECUTOR = "anthropic/claude-haiku-4-5";
const DEFAULT_ADVISOR_PLUS = "anthropic/claude-sonnet-4-6";
const DEFAULT_ADVISOR_MAX = "anthropic/claude-opus-4-8";

/**
 * Curated, user-selectable models (the agent model picker). An allowlist so a
 * client-supplied `model` can't inject an arbitrary key. Index 0 is the default.
 * Native ids (Haiku 4.5 = cheapest tool-capable model; Sonnet 4.6 = opt-in upgrade).
 */
export const AI_MODELS: AiModel[] = [
	{ id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic" },
	{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
];

const ALLOWED_MODELS = new Set(AI_MODELS.map((m) => m.id));

/** A resolved model: the SDK handle for the call + the canonical key for metering. */
export interface ResolvedModel {
	/** The AI SDK language model to pass to streamText/generateText/generateObject. */
	model: LanguageModel;
	/** The canonical `provider/native-id` key — the ledger/cost/analytics key. */
	key: string;
	/** The provider the key resolves to (gates provider-specific `providerOptions`). */
	provider: ProviderId;
}

// Lazily-built provider singletons. Constructed on first use (not at import) so `env()`
// resolves the runtime key; the API key defaults to the provider SDK's own env var when unset.
let anthropicProvider: AnthropicProvider | undefined;
let openaiProvider: OpenAIProvider | undefined;

/** The memoized Anthropic provider (reads ANTHROPIC_API_KEY at runtime via next-runtime-env). */
function getAnthropicProvider(): AnthropicProvider {
	anthropicProvider ??= createAnthropic({ apiKey: env("ANTHROPIC_API_KEY") });
	return anthropicProvider;
}

/** The memoized OpenAI provider (reads OPENAI_API_KEY at runtime via next-runtime-env). */
function getOpenAiProvider(): OpenAIProvider {
	openaiProvider ??= createOpenAI({ apiKey: env("OPENAI_API_KEY") });
	return openaiProvider;
}

/** Split a canonical `provider/native-id` key into its provider + native id (defaults to anthropic). */
function parseKey(key: string): { provider: ProviderId; id: string } {
	const slash = key.indexOf("/");
	if (slash === -1) return { provider: "anthropic", id: key };
	const provider = key.slice(0, slash);
	const id = key.slice(slash + 1);
	if (provider === "openai") return { provider: "openai", id };
	if (provider === "anthropic") return { provider: "anthropic", id };
	// Unknown prefix → treat the whole key as an Anthropic native id (never the gateway).
	return { provider: "anthropic", id: key };
}

/** The distinct providers referenced by the current role/override configuration. */
function configuredProviders(): Set<ProviderId> {
	const keys = [
		env("AI_EXECUTOR_MODEL") || DEFAULT_EXECUTOR,
		env("AI_ADVISOR_MODEL_PLUS") || DEFAULT_ADVISOR_PLUS,
		env("AI_ADVISOR_MODEL_MAX") || DEFAULT_ADVISOR_MAX,
		env("AI_MODEL") || "",
	].filter(Boolean);
	return new Set(keys.map((k) => parseKey(k).provider));
}

/**
 * Resolve a canonical `provider/native-id` key to a live SDK model + the key itself.
 * Routes directly to the provider's API — no Vercel AI Gateway in the path.
 */
export function resolveModel(key: string): ResolvedModel {
	const { provider, id } = parseKey(key);
	// E2E only (ALETHIA_AI_MOCK=1): a scripted model so the whole pipeline — route,
	// tools, grid, persistence — runs for real against deterministic "AI" responses.
	// Inert in every real deployment (the env is never set).
	if (isAiMock()) return { model: mockLanguageModel(id), key, provider };
	const model =
		provider === "openai" ? getOpenAiProvider()(id) : getAnthropicProvider()(id);
	return { model, key, provider };
}

/**
 * Resolve the model for an assistant request. A client `override` wins only if it's in
 * the allowlist (anti-injection); otherwise env `AI_MODEL`, then the default executor.
 */
export function getAiModel(override?: string): ResolvedModel {
	if (override && ALLOWED_MODELS.has(override)) return resolveModel(override);
	const envModel = env("AI_MODEL");
	if (envModel) return resolveModel(envModel);
	return getExecutorModel();
}

/** Whether `id` is a selectable model — i.e. a deliberate client-picker choice (allowlist). */
export function isSelectableModel(id: string | undefined | null): id is string {
	return Boolean(id && ALLOWED_MODELS.has(id));
}

/**
 * The cheap **executor** model that runs the agent tool loop — the cost-optimized default
 * that does most of the tokens. Haiku 4.5 by default; override with `AI_EXECUTOR_MODEL`.
 */
export function getExecutorModel(): ResolvedModel {
	return resolveModel(env("AI_EXECUTOR_MODEL") || DEFAULT_EXECUTOR);
}

/**
 * The **advisor** (planning/review) model for an org's AI tier. The agent's step 0 (planning)
 * runs on the advisor; the tool loop runs on the executor. Per model:
 *  - `ai_plus` → Sonnet 4.6 (`AI_ADVISOR_MODEL_PLUS`).
 *  - `ai_max`  → Sonnet 4.6 by DEFAULT (same as Plus, just larger allowances), upgrading to the
 *    Opus advisor (`AI_ADVISOR_MODEL_MAX`) ONLY when `opts.deepReasoning` is set — the per-message
 *    "deep reasoning" opt-in. Metering is per-model, so an Opus turn tracks its own (higher) cost.
 *  - `ai_free` → no distinct advisor → the executor (Haiku).
 * Each tier is overridable via `AI_ADVISOR_MODEL_MAX` / `AI_ADVISOR_MODEL_PLUS`.
 *
 * @param tier - the org's effective AI tier.
 * @param opts.deepReasoning - when true AND `tier === "ai_max"`, bind the Opus advisor; ignored otherwise.
 */
export function getAdvisorModel(
	tier: AiTier,
	opts: { deepReasoning?: boolean } = {},
): ResolvedModel {
	if (tier === "ai_max" && opts.deepReasoning) {
		return resolveModel(env("AI_ADVISOR_MODEL_MAX") || DEFAULT_ADVISOR_MAX);
	}
	if (tier === "ai_max" || tier === "ai_plus") {
		return resolveModel(env("AI_ADVISOR_MODEL_PLUS") || DEFAULT_ADVISOR_PLUS);
	}
	return getExecutorModel();
}

/**
 * Whether the AI layer is configured. Direct-to-provider: every provider referenced by the
 * current role/override config must have its API key set — at minimum `ANTHROPIC_API_KEY`
 * (the default advisor + executor are Anthropic), plus `OPENAI_API_KEY` if any role/override
 * resolves to an `openai/*` model. Without the needed key(s) the routes return 503 and the UI
 * shows a "not configured" state. (The retired gateway's `AI_GATEWAY_API_KEY` no longer counts.)
 */
export function isAiConfigured(): boolean {
	// The scripted E2E model needs no API key.
	if (isAiMock()) return true;
	const providers = configuredProviders();
	if (providers.has("anthropic") && !env("ANTHROPIC_API_KEY")) return false;
	if (providers.has("openai") && !env("OPENAI_API_KEY")) return false;
	return providers.size > 0;
}
