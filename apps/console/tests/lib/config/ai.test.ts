// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AI_MODELS,
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
];
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
	it("maps each AI tier to its advisor model (native keys)", () => {
		// ai_free has no distinct advisor → the executor (Haiku).
		expect(getAdvisorModel("ai_free").key).toBe(getExecutorModel().key);
		expect(getAdvisorModel("ai_plus").key).toBe("anthropic/claude-sonnet-4-6");
		expect(getAdvisorModel("ai_max").key).toBe("anthropic/claude-opus-4-8");
	});

	it("honors per-tier env overrides", () => {
		process.env.AI_ADVISOR_MODEL_MAX = "openai/gpt-5-mini";
		expect(getAdvisorModel("ai_max").key).toBe("openai/gpt-5-mini");
	});
});

describe("isAiConfigured", () => {
	it("requires ANTHROPIC_API_KEY for the default (all-Anthropic) config", () => {
		expect(isAiConfigured()).toBe(false);
		// The retired gateway key no longer counts.
		process.env.AI_GATEWAY_API_KEY = "gw";
		process.env.VERCEL_OIDC_TOKEN = "oidc";
		expect(isAiConfigured()).toBe(false);
		process.env.ANTHROPIC_API_KEY = "sk-ant-x";
		expect(isAiConfigured()).toBe(true);
	});

	it("also requires OPENAI_API_KEY when a role resolves to an openai/* model", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-x"; // advisors default to Anthropic
		process.env.AI_EXECUTOR_MODEL = "openai/gpt-5-mini";
		expect(isAiConfigured()).toBe(false); // OpenAI key missing
		process.env.OPENAI_API_KEY = "sk-openai-x";
		expect(isAiConfigured()).toBe(true);
	});
});
