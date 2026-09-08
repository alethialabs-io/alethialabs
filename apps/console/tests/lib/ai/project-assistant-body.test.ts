// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project-assistant request body, shared by the client's prepareBody and the route. What the
// schema must do: accept today's body unchanged, degrade a bad environment id to "the default
// environment" rather than reject the turn, and never let a stray `view.surface` throw.

import { describe, expect, it } from "vitest";
import {
	assistantViewSchema,
	projectAssistantBodySchema,
} from "@/lib/ai/project-assistant-body";

const ENV = "6f1e2f2a-3b4c-4d5e-8f60-71a2b3c4d5e6";

describe("projectAssistantBodySchema", () => {
	it("accepts the pre-scope body shape and fills the new fields with their defaults", () => {
		const parsed = projectAssistantBodySchema.parse({
			messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
			threadId: "t1",
		});
		expect(parsed.threadId).toBe("t1");
		expect(parsed.environmentId).toBeNull();
		expect(parsed.deepReasoning).toBe(false);
		expect(parsed.view).toBeUndefined();
		expect(parsed.mentions).toBeUndefined();
	});

	it("carries a well-formed environment id and view", () => {
		const parsed = projectAssistantBodySchema.parse({
			messages: [],
			environmentId: ENV,
			deepReasoning: true,
			view: {
				path: "/acme/shop/architecture",
				surface: "architecture",
				openCard: { kind: "inspector", name: "orders" },
			},
		});
		expect(parsed.environmentId).toBe(ENV);
		expect(parsed.deepReasoning).toBe(true);
		expect(parsed.view?.surface).toBe("architecture");
		expect(parsed.view?.openCard).toEqual({ kind: "inspector", name: "orders" });
	});

	it("degrades a malformed environment id to null instead of rejecting the turn", () => {
		const parsed = projectAssistantBodySchema.parse({
			messages: [],
			environmentId: "not-a-uuid",
		});
		expect(parsed.environmentId).toBeNull();
	});

	it("a non-boolean deepReasoning falls back to false", () => {
		const parsed = projectAssistantBodySchema.parse({ messages: [], deepReasoning: "yes" });
		expect(parsed.deepReasoning).toBe(false);
	});

	it("still refuses a body with no messages", () => {
		expect(() => projectAssistantBodySchema.parse({ threadId: "t1" })).toThrow();
	});
});

describe("assistantViewSchema", () => {
	it("an unknown surface reads as other", () => {
		const view = assistantViewSchema.parse({ path: "/acme/x", surface: "wizard" });
		expect(view.surface).toBe("other");
	});
});
