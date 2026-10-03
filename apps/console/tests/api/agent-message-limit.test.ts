// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Every metered chat route — the two Elench posts to, and the agent-scoped `/api/agent/[agentId]`
// — refuses an over-limit user message with a 413 whose body is the shared MESSAGE_TOO_LONG, and
// a body whose messages it cannot read with a 400 (it used to throw a TypeError → a 500), BEFORE
// the AI budget hold is reserved. The limit is the one
// `createThread` and the composer enforce (lib/ai/message-limits.ts). Before #5423's repair the
// action capped a first turn at 100k while these routes capped nothing, so a long first message
// threw inside `startThread` and the send vanished. Every collaborator is mocked; what is
// asserted is the refusal, its body, and that no budget was touched.

import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("ai", () => ({
	convertToModelMessages: vi.fn(async (m: unknown) => m),
	createUIMessageStream: vi.fn(() => ({})),
	createUIMessageStreamResponse: vi.fn(() => new Response("ok")),
	stepCountIs: vi.fn(() => () => false),
	streamText: vi.fn(() => ({
		toUIMessageStream: () => ({}),
		toUIMessageStreamResponse: () => new Response("ok"),
	})),
}));
vi.mock("@/lib/agent/thread-transcript", () => ({ saveThreadTranscript: vi.fn(async () => ({ kind: "saved" })) }));
vi.mock("@/app/server/actions/resolve", () => ({
	resolveActiveEnvironmentId: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/project-knowledge", () => ({
	buildProjectKnowledge: vi.fn(async () => ""),
	formatContextBlock: vi.fn(() => ""),
	readAgentContext: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/environment-knowledge", () => ({
	buildEnvironmentKnowledge: vi.fn(async () => ({ name: null, block: "" })),
}));
vi.mock("@/lib/ai/tools", () => ({
	buildAgentTools: vi.fn(() => ({})),
	buildProjectAgentTools: vi.fn(() => ({})),
}));
vi.mock("@/lib/agent/executor", () => ({
	buildAgentSystemPrompt: vi.fn(() => "system"),
	scopeToolsToAgent: vi.fn(() => ({})),
}));
vi.mock("@/lib/db", () => ({
	withScope: vi.fn(async () => ({ id: "agent-1", tool_scope: [] })),
}));
vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn(async () => "user-1") }));
vi.mock("@/lib/authz/guard", () => ({
	currentActor: vi.fn(async () => ({ userId: "user-1", orgId: "org-1" })),
}));
vi.mock("@/lib/billing/agent-metering", () => ({ recordAgentTurnUsage: vi.fn() }));
vi.mock("@/lib/billing/ai-quota", () => ({
	meteringFailed: vi.fn(() => () => undefined),
	recordAiUsage: vi.fn(),
}));
vi.mock("@/lib/billing/ai-guard", () => ({
	AiBudgetError: class AiBudgetError extends Error {},
	assertAiAllowed: vi.fn(async () => ({ source: "included", credits: 1 })),
	releaseAiHold: vi.fn(),
}));
vi.mock("@/lib/billing/ai-plan", () => ({ resolveAiTier: vi.fn(async () => "ai_free") }));
vi.mock("@/lib/config/ai", () => ({
	isAiConfigured: () => true,
	getAiModel: () => ({ key: "haiku", model: {} }),
	isSelectableModel: () => false,
	resolveModel: () => ({}),
	getExecutorModel: () => ({ key: "haiku", model: {} }),
	getAdvisorModel: () => ({ key: "haiku", model: {} }),
}));

import { assertAiAllowed, releaseAiHold } from "@/lib/billing/ai-guard";
import {
	lastUserMessageTooLong,
	MAX_USER_MESSAGE_CHARS,
	MESSAGE_TOO_LONG,
} from "@/lib/ai/message-limits";

const PROJECT = "2b6c0d1e-7a3c-4b5d-8f0a-1c2d3e4f5a6b";

/** A user turn whose text is `length` characters long. */
function userTurn(length: number, id = "u1"): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text: "a".repeat(length) }] };
}

/** A JSON request body carrying these messages (any value: the malformed cases need that). */
function bodyWith(messages: unknown): string {
	return JSON.stringify({ messages });
}

/** POST the org agent route (`/api/agent`) with this raw body. */
async function postOrg(body: string): Promise<Response> {
	const { POST } = await import("@/app/api/agent/route");
	return POST(new Request("https://console.local/api/agent", { method: "POST", body }));
}

/** POST the project assistant route with this raw body. */
async function postProject(body: string): Promise<Response> {
	const { POST } = await import("@/app/api/projects/[projectId]/assistant/route");
	return POST(
		new Request(`https://console.local/api/projects/${PROJECT}/assistant`, {
			method: "POST",
			body,
		}),
		{ params: Promise.resolve({ projectId: PROJECT }) },
	);
}

/** POST the agent-scoped route (`/api/agent/[agentId]`) with this raw body. */
async function postAgent(body: string): Promise<Response> {
	const { POST } = await import("@/app/api/agent/[agentId]/route");
	return POST(new Request("https://console.local/api/agent/agent-1", { method: "POST", body }), {
		params: Promise.resolve({ agentId: "agent-1" }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe.each([
	["POST /api/agent", postOrg],
	["POST /api/projects/[projectId]/assistant", postProject],
	["POST /api/agent/[agentId]", postAgent],
])("%s — the per-message limit", (_name, post) => {
	it("refuses a user message one character over the limit with 413 and reserves no budget", async () => {
		const res = await post(bodyWith([userTurn(MAX_USER_MESSAGE_CHARS + 1)]));
		expect(res.status).toBe(413);
		expect(await res.text()).toBe(MESSAGE_TOO_LONG);
		expect(assertAiAllowed).not.toHaveBeenCalled();
	});

	it("takes a user message of exactly the limit to the budget gate", async () => {
		const res = await post(bodyWith([userTurn(MAX_USER_MESSAGE_CHARS)]));
		expect(res.status).not.toBe(413);
		expect(assertAiAllowed).toHaveBeenCalledTimes(1);
		expect(releaseAiHold).not.toHaveBeenCalled();
	});

	// A real second turn: the transcript carries an assistant turn whose parts have NO `text`
	// (data, step-start, tool parts). Captured from the elench-ai gate's 400 on this exact shape.
	it("takes a transcript whose earlier turn has text-less parts to the budget gate", async () => {
		const assistant = {
			id: "a1",
			role: "assistant",
			parts: [
				{ type: "data-agent-step", id: "s1", data: { phase: "working" } },
				{ type: "step-start" },
				{ type: "reasoning", id: "r1", text: "thinking", state: "done" },
				{
					type: "tool-build_dashboard",
					toolCallId: "c1",
					state: "output-available",
					input: {},
					output: {},
				},
				{ type: "step-start" },
				{ type: "text", text: "Your dashboard is on the grid.", state: "done" },
			],
		};
		const res = await post(bodyWith([userTurn(10, "u1"), assistant, userTurn(12, "u2")]));
		expect(res.status).not.toBe(400);
		expect(assertAiAllowed).toHaveBeenCalledTimes(1);
	});

	// A body the limit cannot read is the CLIENT's error: a 400, never a TypeError surfacing as
	// a 500, and still before the hold.
	it.each([
		["no messages at all", JSON.stringify({})],
		["messages that is not a list", bodyWith("hello")],
		["a message with no parts", bodyWith([{ id: "u", role: "user" }])],
		["a text part with no text", bodyWith([{ id: "u", role: "user", parts: [{ type: "text" }] }])],
		["a JSON null body", "null"],
		["a body that is not JSON", "{not json"],
	])("answers 400 for %s and reserves no budget", async (_case, body) => {
		const res = await post(body);
		expect(res.status).toBe(400);
		expect(assertAiAllowed).not.toHaveBeenCalled();
	});
});

// `mode` picks the prompt and the tool set, and `threadId` is where the reply is stored and what
// the hold is booked against — both validated before the hold, so a bad value is a 400 that
// reserves nothing (an unknown mode used to run silently as Ask; a non-uuid thread id reached
// Postgres only after the turn was paid for).
describe("POST /api/agent — mode and threadId", () => {
	const THREAD = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
	/** A valid one-turn body with these extra fields. */
	const withFields = (fields: Record<string, unknown>) =>
		JSON.stringify({ messages: [userTurn(5)], ...fields });

	it.each([
		["an unknown mode", { mode: "admin" }],
		["a mode that is not a string", { mode: 1 }],
		["a threadId that is not a uuid", { threadId: "t-1" }],
		["a threadId that is not a string", { threadId: 42 }],
	])("answers 400 for %s and reserves no budget", async (_case, fields) => {
		const res = await postOrg(withFields(fields));
		expect(res.status).toBe(400);
		expect(assertAiAllowed).not.toHaveBeenCalled();
	});

	it.each([
		["no mode and no threadId", {}],
		["mode act with a uuid threadId", { mode: "act", threadId: THREAD }],
		["mode ask with a null threadId", { mode: "ask", threadId: null }],
	])("takes %s to the budget gate", async (_case, fields) => {
		const res = await postOrg(withFields(fields));
		expect(res.status).not.toBe(400);
		expect(assertAiAllowed).toHaveBeenCalledTimes(1);
	});
});

describe("lastUserMessageTooLong", () => {
	it("reads only the LAST message, and only when it is the user's", () => {
		const long = userTurn(MAX_USER_MESSAGE_CHARS + 1, "old");
		const reply: UIMessage = {
			id: "a1",
			role: "assistant",
			parts: [{ type: "text", text: "a".repeat(MAX_USER_MESSAGE_CHARS + 1) }],
		};
		// An over-limit turn stored before the limit existed must not lock the thread.
		expect(lastUserMessageTooLong([long, reply, userTurn(5, "new")])).toBe(false);
		expect(lastUserMessageTooLong([userTurn(5), reply])).toBe(false);
		expect(lastUserMessageTooLong([userTurn(5), long])).toBe(true);
		expect(lastUserMessageTooLong([])).toBe(false);
	});

	it("sums every text part of the message", () => {
		const half = Math.ceil(MAX_USER_MESSAGE_CHARS / 2) + 1;
		const split: UIMessage = {
			id: "u",
			role: "user",
			parts: [
				{ type: "text", text: "a".repeat(half) },
				{ type: "text", text: "a".repeat(half) },
			],
		};
		expect(lastUserMessageTooLong([split])).toBe(true);
	});
});
