// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The project-assistant request body, shared by the client's prepareBody and the route. What the
// schema must do: accept today's body unchanged, degrade a bad environment id to "the default
// environment" rather than reject the turn, and never let a stray `view.surface` throw.

import { describe, expect, it } from "vitest";
import {
	assistantViewSchema,
	parseProjectAssistantBody,
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

describe("parseProjectAssistantBody", () => {
	// The route replaced an untyped destructure with this. A bare `.parse()` would have been
	// strictly stricter — a shape the route used to accept would throw out of the handler and 500
	// the turn, AFTER the AI budget hold was reserved. Both arms of that decision are pinned here,
	// because only one of them is on the happy path.
	it("returns the parsed body when it is well formed", () => {
		const result = parseProjectAssistantBody({
			messages: [],
			environmentId: ENV,
			view: { path: "/a/b/architecture", surface: "architecture" },
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.environmentId).toBe(ENV);
		expect(result.value.view?.surface).toBe("architecture");
	});

	it("degrades the same inputs the route degraded before it existed", () => {
		const result = parseProjectAssistantBody({
			messages: [],
			environmentId: "nonsense",
			deepReasoning: "yes",
			mentions: [{ shape: "wrong" }],
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.environmentId).toBeNull();
		expect(result.value.deepReasoning).toBe(false);
		expect(result.value.mentions).toBeUndefined();
	});

	it("reports the offending path rather than throwing, so the route can answer 400", () => {
		const result = parseProjectAssistantBody({ threadId: "t1" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("messages");
	});

	// The Elench store types `threadId` as `string | null` and the client sends it straight through,
	// so a fresh project conversation puts an explicit `null` on the wire. `.optional()` accepts only
	// `undefined`, so the schema rejected the shape the live client ALWAYS sends on a first turn and
	// every new project conversation died at the door.
	it("accepts the explicit null a fresh conversation sends for threadId", () => {
		const result = parseProjectAssistantBody({ messages: [], threadId: null });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.threadId ?? null).toBeNull();
	});

	it("still accepts an omitted threadId and a real one", () => {
		expect(parseProjectAssistantBody({ messages: [] }).ok).toBe(true);
		const withId = parseProjectAssistantBody({ messages: [], threadId: "t1" });
		expect(withId.ok).toBe(true);
		if (!withId.ok) return;
		expect(withId.value.threadId).toBe("t1");
	});

	it("a body that is not an object at all is a message, not a crash", () => {
		for (const body of [null, undefined, "nope", 7, []]) {
			const result = parseProjectAssistantBody(body);
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.message.length).toBeGreaterThan(0);
		}
	});
});

describe("assistantViewSchema", () => {
	it("an unknown surface reads as other", () => {
		const view = assistantViewSchema.parse({ path: "/acme/x", surface: "wizard" });
		expect(view.surface).toBe("other");
	});
});
