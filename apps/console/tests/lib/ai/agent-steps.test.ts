// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit tests for the orchestration-marker emission rule (lib/ai/agent-steps): a turn
// shows at most two separators — PLAN at step 0 (the advisor) and EXECUTE at the first
// model change — and a forced client pick shows a single EXECUTE marker. Also pins the
// client-safe model-label formatter and the zod round-trip.

import { describe, expect, it } from "vitest";
import {
	agentStepDataSchema,
	agentStepMarker,
	modelLabel,
} from "@/lib/ai/agent-steps";

const ORCHESTRATED = {
	clientPick: false,
	advisorKey: "anthropic/claude-sonnet-4-6",
	executorKey: "anthropic/claude-haiku-4-5",
	baseKey: "anthropic/claude-haiku-4-5",
};

describe("agentStepMarker", () => {
	it("emits PLAN with the advisor at step 0", () => {
		expect(agentStepMarker({ ...ORCHESTRATED, stepNumber: 0 })).toEqual({
			step: 0,
			phase: "plan",
			model: "anthropic/claude-sonnet-4-6",
			label: "Claude Sonnet 4.6",
		});
	});

	it("emits EXECUTE with the executor at the first model change (step 1)", () => {
		expect(agentStepMarker({ ...ORCHESTRATED, stepNumber: 1 })).toEqual({
			step: 1,
			phase: "execute",
			model: "anthropic/claude-haiku-4-5",
			label: "Claude Haiku 4.5",
		});
	});

	it("emits nothing on subsequent executor loop steps", () => {
		expect(agentStepMarker({ ...ORCHESTRATED, stepNumber: 2 })).toBeNull();
		expect(agentStepMarker({ ...ORCHESTRATED, stepNumber: 7 })).toBeNull();
	});

	it("emits no EXECUTE marker when the advisor IS the executor (ai_free)", () => {
		const free = {
			...ORCHESTRATED,
			advisorKey: "anthropic/claude-haiku-4-5",
		};
		expect(agentStepMarker({ ...free, stepNumber: 0 })?.phase).toBe("plan");
		expect(agentStepMarker({ ...free, stepNumber: 1 })).toBeNull();
	});

	it("emits a single EXECUTE marker for a forced client pick", () => {
		const picked = {
			clientPick: true,
			advisorKey: "anthropic/claude-sonnet-4-6",
			executorKey: "anthropic/claude-haiku-4-5",
			baseKey: "anthropic/claude-sonnet-4-6",
		};
		expect(agentStepMarker({ ...picked, stepNumber: 0 })).toEqual({
			step: 0,
			phase: "execute",
			model: "anthropic/claude-sonnet-4-6",
			label: "Claude Sonnet 4.6",
		});
		expect(agentStepMarker({ ...picked, stepNumber: 1 })).toBeNull();
	});

	it("round-trips through the zod schema (the wire contract)", () => {
		const marker = agentStepMarker({ ...ORCHESTRATED, stepNumber: 0 });
		expect(agentStepDataSchema.safeParse(marker).success).toBe(true);
	});
});

describe("modelLabel", () => {
	it("formats Anthropic keys with a dotted version", () => {
		expect(modelLabel("anthropic/claude-opus-4-8")).toBe("Claude Opus 4.8");
		expect(modelLabel("anthropic/claude-haiku-4-5")).toBe("Claude Haiku 4.5");
	});

	it("upper-cases gpt and tolerates non-numeric tails", () => {
		expect(modelLabel("openai/gpt-5-mini")).toBe("GPT 5 Mini");
	});

	it("falls back to the key when there is nothing to format", () => {
		expect(modelLabel("x")).toBe("X");
	});
});
