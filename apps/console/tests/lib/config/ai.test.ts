// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AI_MODELS,
	aiDisabledReason,
	getAdvisorModel,
	getAiModel,
	getExecutorModel,
	isAiConfigured,
	isSelectableModel,
	resolveModel,
} from "@/lib/config/ai";

const KEYS = [
	"AI_MODEL",
	"AI_EXECUTOR_MODEL",
	"AI_ADVISOR_MODEL_PLUS",
	"AI_ADVISOR_MODEL_MAX",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"AI_GATEWAY_API_KEY",
	"VERCEL_OIDC_TOKEN",
	// The transparency evidence (#2373). Cleared per test like the keys, so a developer's own
	// environment cannot make the fail-closed gate look open.
	"ALETHIA_AI_ANTHROPIC_DPA",
	"ALETHIA_AI_ANTHROPIC_TRANSFER",
	"ALETHIA_AI_ANTHROPIC_RETENTION",
	"ALETHIA_AI_ANTHROPIC_NO_TRAINING",
	"ALETHIA_AI_OPENAI_DPA",
	"ALETHIA_AI_OPENAI_TRANSFER",
	"ALETHIA_AI_OPENAI_RETENTION",
	"ALETHIA_AI_OPENAI_NO_TRAINING",
	// The scripted E2E model. Cleared per test so an ambient ALETHIA_AI_MOCK=1 in a developer's
	// shell cannot make the fail-closed gate look open — it short-circuits everything below.
	"ALETHIA_AI_MOCK",
];

/** Arms the four transparency values for a provider — what a configured deployment looks like. */
function armEvidence(provider: "ANTHROPIC" | "OPENAI"): void {
	process.env[`ALETHIA_AI_${provider}_DPA`] = "DPA in force (2026-08-01)";
	process.env[`ALETHIA_AI_${provider}_TRANSFER`] = "EU SCCs module 2";
	process.env[`ALETHIA_AI_${provider}_RETENTION`] = "30 days, then deleted";
	process.env[`ALETHIA_AI_${provider}_NO_TRAINING`] = "Excluded from training by contract";
}
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
	for (const k of KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

/** Read a resolved model's provider id (the SDK sets `.provider` on the model object). */
function providerOf(model: ReturnType<typeof resolveModel>["model"]): string {
	if (typeof model === "string") return model;
	return model.provider;
}

describe("resolveModel", () => {
	it("returns the SDK model + the canonical key, routed to the right provider", () => {
		const anthropic = resolveModel("anthropic/claude-haiku-4-5");
		expect(anthropic.key).toBe("anthropic/claude-haiku-4-5");
		expect(providerOf(anthropic.model)).toContain("anthropic");

		const openai = resolveModel("openai/gpt-5-mini");
		expect(openai.key).toBe("openai/gpt-5-mini");
		expect(providerOf(openai.model)).toContain("openai");
	});
});

describe("getAiModel", () => {
	it("honors an override only if it's in the allowlist", () => {
		expect(getAiModel("anthropic/claude-sonnet-4-6").key).toBe(
			"anthropic/claude-sonnet-4-6",
		);
		// A non-allowlisted override is rejected (anti-injection) → falls through to the default.
		// Opus is not in the allowlist, so it no longer passes through either.
		expect(getAiModel("anthropic/claude-opus-4-8").key).toBe(AI_MODELS[0].id);
		expect(getAiModel("evil/jailbreak-model").key).toBe(AI_MODELS[0].id);
	});

	it("falls back to env AI_MODEL, then the default executor (index 0)", () => {
		process.env.AI_MODEL = "anthropic/some-env-model";
		expect(getAiModel().key).toBe("anthropic/some-env-model");
		delete process.env.AI_MODEL;
		expect(getAiModel().key).toBe(AI_MODELS[0].id);
	});

	it("defaults to Claude Haiku 4.5 at index 0 (cheapest tool-capable model)", () => {
		expect(AI_MODELS[0].id).toBe("anthropic/claude-haiku-4-5");
	});
});

describe("isSelectableModel", () => {
	it("is true only for allowlisted model ids", () => {
		expect(isSelectableModel("anthropic/claude-sonnet-4-6")).toBe(true);
		expect(isSelectableModel("anthropic/claude-haiku-4-5")).toBe(true);
		expect(isSelectableModel("anthropic/claude-opus-4-8")).toBe(false); // not selectable
		expect(isSelectableModel("evil/jailbreak")).toBe(false);
		expect(isSelectableModel(undefined)).toBe(false);
		expect(isSelectableModel(null)).toBe(false);
	});
});

describe("getExecutorModel", () => {
	it("is the cheap Haiku executor by default (matches MODEL_PRICES / AI_MODELS default)", () => {
		expect(getExecutorModel().key).toBe("anthropic/claude-haiku-4-5");
	});

	it("is env-overridable via AI_EXECUTOR_MODEL (config flip, not a rebuild)", () => {
		process.env.AI_EXECUTOR_MODEL = "openai/gpt-5-mini";
		const executor = getExecutorModel();
		expect(executor.key).toBe("openai/gpt-5-mini");
		expect(providerOf(executor.model)).toContain("openai");
	});
});

describe("getAdvisorModel", () => {
	it("maps each AI tier to its DEFAULT advisor model (native keys)", () => {
		// ai_free has no distinct advisor → the executor (Haiku).
		expect(getAdvisorModel("ai_free").key).toBe(getExecutorModel().key);
		expect(getAdvisorModel("ai_plus").key).toBe("anthropic/claude-sonnet-4-6");
		// Max defaults to the Sonnet advisor (like Plus, just larger allowances) — NOT Opus.
		expect(getAdvisorModel("ai_max").key).toBe("anthropic/claude-sonnet-4-6");
	});

	it("upgrades ai_max to the Opus advisor ONLY with deepReasoning", () => {
		// The per-message opt-in swaps Max's advisor to Opus (a distinct, higher-cost ledger row).
		expect(getAdvisorModel("ai_max", { deepReasoning: true }).key).toBe(
			"anthropic/claude-opus-4-8",
		);
		// deepReasoning is a no-op on the lower tiers (the config guards it to ai_max).
		expect(getAdvisorModel("ai_plus", { deepReasoning: true }).key).toBe(
			"anthropic/claude-sonnet-4-6",
		);
		expect(getAdvisorModel("ai_free", { deepReasoning: true }).key).toBe(
			getExecutorModel().key,
		);
	});

	it("honors per-tier env overrides", () => {
		// The Plus default also backs Max's default advisor now.
		process.env.AI_ADVISOR_MODEL_PLUS = "openai/gpt-5-mini";
		expect(getAdvisorModel("ai_plus").key).toBe("openai/gpt-5-mini");
		expect(getAdvisorModel("ai_max").key).toBe("openai/gpt-5-mini");
		// The Max override applies only on the deep-reasoning (Opus) path.
		process.env.AI_ADVISOR_MODEL_MAX = "openai/gpt-5";
		expect(getAdvisorModel("ai_max", { deepReasoning: true }).key).toBe("openai/gpt-5");
	});
});

describe("isAiConfigured", () => {
	it("requires ANTHROPIC_API_KEY for the default (all-Anthropic) config", () => {
		expect(isAiConfigured()).toBe(false);
		// The retired gateway key no longer counts.
		process.env.AI_GATEWAY_API_KEY = "gw";
		process.env.VERCEL_OIDC_TOKEN = "oidc";
		expect(isAiConfigured()).toBe(false);
		// A KEY IS NO LONGER ENOUGH (#2373): the transparency evidence has to be recorded too, so
		// this stays false with a valid key and nothing else.
		process.env.ANTHROPIC_API_KEY = "sk-ant-x";
		expect(isAiConfigured()).toBe(false);
		armEvidence("ANTHROPIC");
		expect(isAiConfigured()).toBe(true);
	});

	it("also requires OPENAI_API_KEY when a role resolves to an openai/* model", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-x"; // advisors default to Anthropic
		armEvidence("ANTHROPIC");
		process.env.AI_EXECUTOR_MODEL = "openai/gpt-5-mini";
		expect(isAiConfigured()).toBe(false); // OpenAI key missing
		process.env.OPENAI_API_KEY = "sk-openai-x";
		// Still false: the SECOND provider needs its own evidence. A deployment that added OpenAI
		// without a DPA for it would otherwise inherit Anthropic's, which is exactly the leak this
		// gate exists to prevent.
		expect(isAiConfigured()).toBe(false);
		armEvidence("OPENAI");
		expect(isAiConfigured()).toBe(true);
	});
});

describe("aiDisabledReason", () => {
	// A 503 body that says "not configured" is useless to the operator who has to fix it. The reason
	// names the variable, which is the difference between an outage and a task.
	it("is null when everything is in place", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-x";
		armEvidence("ANTHROPIC");
		expect(aiDisabledReason()).toBeNull();
	});

	it("names the missing API key", () => {
		armEvidence("ANTHROPIC");
		expect(aiDisabledReason()).toContain("ANTHROPIC_API_KEY");
	});

	it("names each missing transparency variable, one at a time", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-x";
		for (const name of [
			"ALETHIA_AI_ANTHROPIC_DPA",
			"ALETHIA_AI_ANTHROPIC_TRANSFER",
			"ALETHIA_AI_ANTHROPIC_RETENTION",
			"ALETHIA_AI_ANTHROPIC_NO_TRAINING",
		]) {
			armEvidence("ANTHROPIC");
			delete process.env[name];
			const reason = aiDisabledReason();
			expect(reason).toContain(name);
		}
	});

	// The explanation has to survive being read by someone who wants to skip it.
	it("says why a prompt is not sent, not merely that it is not", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-x";
		expect(aiDisabledReason()).toMatch(/infrastructure and code/i);
	});
});

describe("the scripted E2E model", () => {
	// The ONE exemption from the transparency gate, and it is exempt because it is not a provider:
	// the scripted model sends nothing anywhere, so there is no third party to have an agreement
	// with. Pinned because "tighten the gate, no exceptions" is a plausible-looking change that
	// would take every AI e2e leg down with it.
	it("is configured without an API key or any transparency evidence", () => {
		process.env.ALETHIA_AI_MOCK = "1";
		expect(isAiConfigured()).toBe(true);
		expect(aiDisabledReason()).toBeNull();
	});
});
