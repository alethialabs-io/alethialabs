// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Both chat routes Elench posts to refuse an over-limit user message with a 413 whose body is
// the shared MESSAGE_TOO_LONG, BEFORE the AI budget hold is reserved. The limit is the one
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
	streamText: vi.fn(() => ({ toUIMessageStream: () => ({}) })),
}));
vi.mock("@/app/server/actions/agent", () => ({ saveThreadMessages: vi.fn() }));
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
	isSelectableModel: () => false,
	resolveModel: () => ({}),
	getExecutorModel: () => ({ key: "haiku", model: {} }),
	getAdvisorModel: () => ({ key: "haiku", model: {} }),
}));

import { assertAiAllowed } from "@/lib/billing/ai-guard";
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

/** POST the org agent route (`/api/agent`) with these messages. */
async function postOrg(messages: UIMessage[]): Promise<Response> {
	const { POST } = await import("@/app/api/agent/route");
	return POST(
		new Request("https://console.local/api/agent", {
			method: "POST",
			body: JSON.stringify({ messages }),
		}),
	);
}

/** POST the project assistant route with these messages. */
async function postProject(messages: UIMessage[]): Promise<Response> {
	const { POST } = await import("@/app/api/projects/[projectId]/assistant/route");
	return POST(
		new Request(`https://console.local/api/projects/${PROJECT}/assistant`, {
			method: "POST",
			body: JSON.stringify({ messages }),
		}),
		{ params: Promise.resolve({ projectId: PROJECT }) },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe.each([
	["POST /api/agent", postOrg],
	["POST /api/projects/[projectId]/assistant", postProject],
])("%s — the per-message limit", (_name, post) => {
	it("refuses a user message one character over the limit with 413 and reserves no budget", async () => {
		const res = await post([userTurn(MAX_USER_MESSAGE_CHARS + 1)]);
		expect(res.status).toBe(413);
		expect(await res.text()).toBe(MESSAGE_TOO_LONG);
		expect(assertAiAllowed).not.toHaveBeenCalled();
	});

	it("takes a user message of exactly the limit to the budget gate", async () => {
		const res = await post([userTurn(MAX_USER_MESSAGE_CHARS)]);
		expect(res.status).not.toBe(413);
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
