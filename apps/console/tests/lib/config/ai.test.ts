// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AI_MODELS, getAiModel, isAiConfigured } from "@/lib/config/ai";

const KEYS = ["AI_MODEL", "AI_GATEWAY_API_KEY", "VERCEL_OIDC_TOKEN"];
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

describe("getAiModel", () => {
	it("honors an override only if it's in the allowlist", () => {
		expect(getAiModel("anthropic/claude-opus-4.8")).toBe("anthropic/claude-opus-4.8");
		// A non-allowlisted override is rejected (anti-injection) → falls through to the default.
		expect(getAiModel("evil/jailbreak-model")).toBe(AI_MODELS[0].id);
	});

	it("falls back to env AI_MODEL, then the default (index 0)", () => {
		process.env.AI_MODEL = "some/env-model";
		expect(getAiModel()).toBe("some/env-model");
		delete process.env.AI_MODEL;
		expect(getAiModel()).toBe(AI_MODELS[0].id);
	});

	it("defaults to Claude Sonnet at index 0", () => {
		expect(AI_MODELS[0].id).toBe("anthropic/claude-sonnet-4.6");
	});
});

describe("isAiConfigured", () => {
	it("is true with a gateway key or Vercel OIDC token, false otherwise", () => {
		expect(isAiConfigured()).toBe(false);
		process.env.AI_GATEWAY_API_KEY = "k";
		expect(isAiConfigured()).toBe(true);
		delete process.env.AI_GATEWAY_API_KEY;
		process.env.VERCEL_OIDC_TOKEN = "t";
		expect(isAiConfigured()).toBe(true);
	});
});
