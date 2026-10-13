// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0003 slice 2, the U tests of §11: the turn key (`turnText`, `pendingClientToolCalls`,
// `hasAcceptedApproval`, the §5.2 classifier) and the client-tool list with its output schemas.
// Pure functions over hand-built UI messages; the only mocks are the server actions the real
// tool sets import, so the CLIENT_TOOL_NAMES test reads the routes' actual tool definitions.

import type { UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/aws/identities");
vi.mock("@/app/server/actions/cloud-resources");
vi.mock("@/app/server/actions/clusters");
vi.mock("@/app/server/actions/connectors");
vi.mock("@/app/server/actions/jobs");
vi.mock("@/lib/pricing/region-prices");
vi.mock("@/app/server/actions/projects");
vi.mock("@/app/server/actions/runners");
vi.mock("@/app/server/actions/scanner");

import {
	type ClaimSnapshot,
	type ClassifyTurnInput,
	classifyTurn,
	continuationKey,
	hasAcceptedApproval,
	pendingClientToolCalls,
	type TurnRequest,
	turnText,
} from "@/lib/agent/turn-key";
import {
	CLIENT_TOOL_NAMES,
	CLIENT_TOOL_OUTPUT_MAX_BYTES,
	parseClientToolOutput,
} from "@/lib/ai/client-tools";
import { buildAgentTools, buildProjectAgentTools } from "@/lib/ai/tools";
import { buildSupportTools } from "@/lib/ai/tools/support";

const PROJECT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const JOB = "9b2f4d8e-1c3a-4b5d-8e6f-7a8b9c0d1e2f";
const CASE = "3f1e2d4c-5b6a-4789-8abc-def012345678";

/** A user message whose parts are the given texts. */
function user(id: string, ...texts: string[]): UIMessage {
	return { id, role: "user", parts: texts.map((text) => ({ type: "text", text })) };
}

/** An assistant message with the given parts. */
function assistant(id: string, parts: UIMessage["parts"]): UIMessage {
	return { id, role: "assistant", parts };
}

/** A `propose_operation` call, with its output when one is given. */
function proposal(toolCallId: string, output?: unknown): UIMessage["parts"][number] {
	const input = { operation: { operation: "plan_project", projectId: PROJECT }, summary: "s" };
	return output === undefined
		? { type: "tool-propose_operation", toolCallId, state: "input-available", input }
		: { type: "tool-propose_operation", toolCallId, state: "output-available", input, output };
}

/** A server-executed read tool call (`list_projects`) with its stored output. */
function serverRead(toolCallId: string): UIMessage["parts"][number] {
	return {
		type: "tool-list_projects",
		toolCallId,
		state: "output-available",
		input: {},
		output: [],
	};
}

const APPROVED = {
	status: "approved",
	operation: "plan_project",
	projectId: PROJECT,
	environmentId: null,
	jobId: JOB,
};

/** A classifier input with the defaults most rows share. */
function input(over: Partial<ClassifyTurnInput> & { turn: TurnRequest }): ClassifyTurnInput {
	return { requestMessages: [], stored: [], revision: 3, claims: [], ...over };
}

describe("turnText", () => {
	it("turnText of a D12 first send equals the trimmed stored text", () => {
		// The composer sends what was typed; startConversation stores it trimmed.
		expect(turnText(user("u", "  deploy staging\n"))).toBe(turnText(user("u", "deploy staging")));
		expect(turnText(user("u", "  deploy staging\n"))).toBe("deploy staging");
	});

	it("CRLF and LF, and a trailing newline, compare equal", () => {
		expect(turnText(user("u", "a\r\nb\rc\n"))).toBe(turnText(user("u", "a\nb\nc")));
		expect(turnText(user("u", "a\r\nb"))).toBe("a\nb");
	});

	it("joins text parts with no separator and ignores every other part and the metadata", () => {
		const m: UIMessage = {
			id: "u",
			role: "user",
			metadata: { mentions: ["x"] },
			parts: [
				{ type: "text", text: "plan " },
				{ type: "file", mediaType: "image/png", url: "data:," },
				{ type: "text", text: "it" },
			],
		};
		expect(turnText(m)).toBe("plan it");
	});

	it("removes U+0000 and replaces a lone surrogate (ADR 0001 §4.1's normalization)", () => {
		expect(turnText(user("u", "a\u0000b"))).toBe("ab");
		expect(turnText(user("u", "x\uD800"))).toBe("x�");
	});
});

describe("pendingClientToolCalls", () => {
	it("reads the last step that holds a client tool, sorted", () => {
		const a = assistant("a", [
			{ type: "step-start" },
			proposal("call-z"),
			{ type: "step-start" },
			proposal("call-b"),
			proposal("call-a"),
		]);
		expect(pendingClientToolCalls(a)).toEqual(["call-a", "call-b"]);
	});

	it("the pending set of a continued answer is the approval's step, not its last step", () => {
		const continued = assistant("a", [
			{ type: "step-start" },
			{ type: "text", text: "I will plan it." },
			proposal("call-1", APPROVED),
			{ type: "step-start" },
			{ type: "text", text: "The plan is queued." },
			{ type: "step-start" },
			serverRead("read-9"),
		]);
		expect(pendingClientToolCalls(continued)).toEqual(["call-1"]);
	});

	it("a mixed step names only the proposal, with or without the outputs stored", () => {
		// The client's copy: the user just approved, the read's output arrived with the stream.
		const clientCopy = assistant("a", [
			{ type: "step-start" },
			serverRead("read-1"),
			proposal("call-1", APPROVED),
		]);
		// The stored row: the read's output stored by finalize, the proposal's not yet.
		const storedRow = assistant("a", [
			{ type: "step-start" },
			serverRead("read-1"),
			proposal("call-1"),
		]);
		expect(pendingClientToolCalls(clientCopy)).toEqual(["call-1"]);
		expect(pendingClientToolCalls(storedRow)).toEqual(["call-1"]);
	});

	it("ignores a provider-executed part and a non-client tool", () => {
		const a = assistant("a", [
			{ type: "step-start" },
			{
				type: "tool-propose_operation",
				toolCallId: "p",
				state: "input-available",
				input: {},
				providerExecuted: true,
			},
			serverRead("r"),
		]);
		expect(pendingClientToolCalls(a)).toEqual([]);
	});

	it("reads a dynamic tool part by its tool name", () => {
		const a = assistant("a", [
			{ type: "step-start" },
			{
				type: "dynamic-tool",
				toolName: "create_support_case",
				toolCallId: "case-1",
				state: "input-available",
				input: {},
			},
		]);
		expect(pendingClientToolCalls(a)).toEqual(["case-1"]);
	});
});

describe("hasAcceptedApproval", () => {
	it("is true for an approved proposal and a submitted support case", () => {
		expect(hasAcceptedApproval(assistant("a", [proposal("c", APPROVED)]))).toBe(true);
		const submitted = assistant("a", [
			{
				type: "tool-create_support_case",
				toolCallId: "s",
				state: "output-available",
				input: {},
				output: { status: "submitted", caseId: CASE, caseNumber: 12 },
			},
		]);
		expect(hasAcceptedApproval(submitted)).toBe(true);
	});

	it("is false for outputs that queued nothing, and for a pending card", () => {
		for (const output of [
			{ status: "denied", reason: "no" },
			{ status: "rejected" },
			// A status that is accepted for the OTHER tool is not accepted here.
			{ status: "submitted" },
		]) {
			expect(hasAcceptedApproval(assistant("a", [proposal("c", output)]))).toBe(false);
		}
		expect(hasAcceptedApproval(assistant("a", [proposal("c")]))).toBe(false);
	});

	it("is false for an accepted propose_changes: it ran in the browser and queued nothing", () => {
		const accepted = assistant("a", [
			{
				type: "tool-propose_changes",
				toolCallId: "pc",
				state: "output-available",
				input: { label: "Add a database", actions: [] },
				output: { status: "accepted", label: "Add a database" },
			},
		]);
		expect(pendingClientToolCalls(accepted)).toEqual(["pc"]);
		expect(hasAcceptedApproval(accepted)).toBe(false);
	});
});

describe("CLIENT_TOOL_NAMES", () => {
	it("CLIENT_TOOL_NAMES equals the routes' tools without execute", () => {
		const sets = [
			buildAgentTools({ mode: "act" }),
			buildProjectAgentTools(undefined),
			buildSupportTools(),
		];
		const withoutExecute = new Set<string>();
		for (const set of sets) {
			for (const [name, t] of Object.entries(set)) {
				if (t.execute === undefined) withoutExecute.add(name);
			}
		}
		expect([...withoutExecute].sort()).toEqual([...CLIENT_TOOL_NAMES].sort());
	});
});

describe("parseClientToolOutput", () => {
	it("accepts every output the three cards produce", () => {
		for (const output of [
			APPROVED,
			{ ...APPROVED, operation: "provision_project", environmentId: PROJECT },
			{ status: "denied", reason: "Plan is not allowed." },
			{ status: "rejected" },
		]) {
			expect(parseClientToolOutput("propose_operation", output).ok).toBe(true);
		}
		for (const output of [
			{ status: "submitted", caseId: CASE, caseNumber: 4 },
			{ status: "failed", reason: "Could not open the case." },
			{ status: "dismissed" },
		]) {
			expect(parseClientToolOutput("create_support_case", output).ok).toBe(true);
		}
		expect(
			parseClientToolOutput("propose_changes", { status: "accepted", label: "Add a database" })
				.ok,
		).toBe(true);
	});

	it("refuses an output that fails its schema", () => {
		expect(parseClientToolOutput("propose_operation", { status: "approved" })).toEqual({
			ok: false,
			error: "invalid",
		});
		expect(
			parseClientToolOutput("propose_operation", { ...APPROVED, jobId: "not-a-uuid" }).ok,
		).toBe(false);
		expect(parseClientToolOutput("create_support_case", APPROVED).ok).toBe(false);
		expect(parseClientToolOutput("propose_changes", { status: "accepted" }).ok).toBe(false);
		expect(
			parseClientToolOutput("propose_changes", { status: "accepted", label: "x".repeat(2001) }).ok,
		).toBe(false);
		expect(parseClientToolOutput("propose_changes", { status: "rejected", label: "x" }).ok).toBe(
			false,
		);
		expect(parseClientToolOutput("propose_operation", undefined).ok).toBe(false);
		expect(
			parseClientToolOutput("propose_operation", { status: "denied", reason: "x".repeat(2001) })
				.ok,
		).toBe(false);
	});

	it("refuses an output over 4,096 bytes of JSON, counted in bytes not characters", () => {
		// 1,400 three-byte characters: 1,400 chars (under the reason cap), 4,200+ bytes.
		const reason = "€".repeat(1400);
		expect(reason.length).toBeLessThanOrEqual(2000);
		expect(new TextEncoder().encode(JSON.stringify({ status: "denied", reason })).byteLength)
			.toBeGreaterThan(CLIENT_TOOL_OUTPUT_MAX_BYTES);
		expect(parseClientToolOutput("propose_operation", { status: "denied", reason })).toEqual({
			ok: false,
			error: "too-large",
		});
	});

	it("strips unknown keys from what it returns", () => {
		const r = parseClientToolOutput("propose_operation", { status: "rejected", extra: 1 });
		expect(r).toEqual({ ok: true, output: { status: "rejected" } });
	});
});

describe("classifyTurn — the submit rows", () => {
	const turn: TurnRequest = { trigger: "submit-message", turnId: "u2", baseRevision: 3 };
	const answered = [user("u1", "hi"), assistant("a1", [{ type: "text", text: "hello" }])];

	it("a new turn at the current revision is an answer attempt that appends u", () => {
		const r = classifyTurn(
			input({ turn, stored: answered, requestMessages: [...answered, user("u2", "plan")] }),
		);
		expect(r).toEqual({ outcome: "accept", kind: "answer", attemptKey: "answer", appendTurn: true });
	});

	it("a new turn at an old baseRevision is transcript-stale, committing nothing", () => {
		const r = classifyTurn(
			input({
				turn,
				revision: 4,
				stored: answered,
				requestMessages: [...answered, user("u2", "plan")],
			}),
		);
		expect(r).toMatchObject({
			outcome: "refuse",
			refusal: "transcript-stale",
			committed: false,
			textCommitted: false,
			answered: false,
		});
	});

	it("a stored, unanswered turn re-sent with equal text answers the stored message", () => {
		const stored = [...answered, user("u2", "plan it")];
		const r = classifyTurn(
			input({ turn, revision: 9, stored, requestMessages: [...answered, user("u2", "plan it\r\n")] }),
		);
		expect(r).toEqual({ outcome: "accept", kind: "answer", attemptKey: "answer", appendTurn: false });
	});

	it("a Retry (regenerate with no answerId) of a stored, unanswered turn is the same answer key", () => {
		const stored = [user("u2", "plan it")];
		const r = classifyTurn(
			input({
				turn: { ...turn, trigger: "regenerate-message" },
				stored,
				requestMessages: [user("u2", "plan it")],
			}),
		);
		expect(r).toMatchObject({ outcome: "accept", attemptKey: "answer", appendTurn: false });
	});

	it("a stored, unanswered turn re-sent with different text is turn-committed-different-text, textCommitted false", () => {
		const stored = [...answered, user("u2", "plan it")];
		const r = classifyTurn(
			input({ turn, stored, requestMessages: [...answered, user("u2", "deploy it")] }),
		);
		expect(r).toEqual({
			outcome: "refuse",
			refusal: "turn-committed-different-text",
			turnId: "u2",
			committed: true,
			textCommitted: false,
			answered: false,
			answerId: null,
		});
	});

	it("an answered turn re-sent with different text is turn-committed-different-text, not turn-answered", () => {
		const stored = [user("u2", "plan it"), assistant("a2", [{ type: "text", text: "ok" }])];
		const r = classifyTurn(input({ turn, stored, requestMessages: [user("u2", "deploy it")] }));
		expect(r).toMatchObject({
			refusal: "turn-committed-different-text",
			committed: true,
			textCommitted: false,
			answered: true,
			answerId: "a2",
		});
	});

	it("an answered turn re-sent with equal text is turn-answered with its answer", () => {
		const stored = [user("u2", "plan it"), assistant("a2", [{ type: "text", text: "ok" }])];
		const r = classifyTurn(input({ turn, stored, requestMessages: [user("u2", "plan it ")] }));
		expect(r).toEqual({
			outcome: "refuse",
			refusal: "turn-answered",
			turnId: "u2",
			committed: true,
			textCommitted: true,
			answered: true,
			answerId: "a2",
		});
	});

	it("a request whose last message is not the turn is invalid, never a claim", () => {
		const r = classifyTurn(input({ turn, requestMessages: [user("u9", "x")] }));
		expect(r.outcome).toBe("invalid");
	});
});

describe("classifyTurn — the regenerate rows", () => {
	const turn: TurnRequest = {
		trigger: "regenerate-message",
		turnId: "u1",
		baseRevision: 3,
		answerId: "a1",
	};
	const stored = [user("u1", "hi"), assistant("a1", [{ type: "text", text: "hello" }])];

	it("the stored last answer of the turn at the current revision is regen:a", () => {
		const r = classifyTurn(input({ turn, stored, requestMessages: [user("u1", "hi")] }));
		expect(r).toEqual({ outcome: "accept", kind: "regenerate", attemptKey: "regen:a1", answerId: "a1" });
	});

	it("regenerate from a tab that never saw the newer answer is turn-answered", () => {
		const newer = [...stored, user("u2", "more"), assistant("a2", [{ type: "text", text: "x" }])];
		const r = classifyTurn(input({ turn, stored: newer, requestMessages: [user("u1", "hi")] }));
		expect(r).toMatchObject({ refusal: "turn-answered", answerId: "a1" });
		const stale = classifyTurn(
			input({ turn, revision: 4, stored, requestMessages: [user("u1", "hi")] }),
		);
		expect(stale).toMatchObject({ refusal: "turn-answered" });
	});

	it("regenerate of an answer with an accepted approval is turn-has-accepted-approval", () => {
		const withApproval = [
			user("u1", "plan"),
			assistant("a1", [{ type: "step-start" }, proposal("c1", APPROVED)]),
		];
		const r = classifyTurn(
			input({ turn, stored: withApproval, requestMessages: [user("u1", "plan")] }),
		);
		expect(r).toEqual({
			outcome: "refuse",
			refusal: "turn-has-accepted-approval",
			turnId: "u1",
			committed: true,
			textCommitted: true,
			answered: true,
			answerId: "a1",
		});
	});

	it("an answer carrying only a rejected proposal may still be regenerated", () => {
		const rejected = [
			user("u1", "plan"),
			assistant("a1", [{ type: "step-start" }, proposal("c1", { status: "rejected" })]),
		];
		const r = classifyTurn(input({ turn, stored: rejected, requestMessages: [user("u1", "plan")] }));
		expect(r).toMatchObject({ outcome: "accept", attemptKey: "regen:a1" });
	});
});

describe("classifyTurn — the continuation rows", () => {
	const proposalStep: UIMessage["parts"] = [
		{ type: "step-start" },
		serverRead("read-1"),
		proposal("call-1"),
	];
	const storedA = assistant("a1", proposalStep);
	const approvedA = assistant("a1", [
		{ type: "step-start" },
		serverRead("read-1"),
		proposal("call-1", APPROVED),
	]);
	const turn: TurnRequest = {
		trigger: "submit-message",
		turnId: "u1",
		baseRevision: 3,
		answerId: "a1",
		toolCallIds: ["call-1"],
	};
	const key = continuationKey("a1", ["call-1"]);

	it("the first approval of a mixed step is continue:a:<the proposal>", () => {
		const r = classifyTurn(
			input({
				turn,
				stored: [user("u1", "plan"), storedA],
				requestMessages: [user("u1", "plan"), approvedA],
			}),
		);
		expect(r).toEqual({
			outcome: "accept",
			kind: "continue",
			attemptKey: "continue:a1:call-1",
			answerId: "a1",
			pending: ["call-1"],
			mode: "first",
		});
	});

	it("the client's pending set over its copy equals the classifier's key over the stored answer", () => {
		// What turnOf sends (slice 6) is pendingClientToolCalls over the client copy.
		const clientIds = pendingClientToolCalls(approvedA);
		const r = classifyTurn(
			input({
				turn: { ...turn, toolCallIds: clientIds },
				stored: [user("u1", "plan"), storedA],
				requestMessages: [user("u1", "plan"), approvedA],
			}),
		);
		expect(r).toMatchObject({ outcome: "accept", attemptKey: continuationKey("a1", clientIds) });
	});

	it("a continuation is never classified by the submit rows", () => {
		// The user turn u1 is stored with an answer: the submit rows would say turn-answered,
		// and its text differs: they would say turn-committed-different-text. Neither applies.
		const r = classifyTurn(
			input({
				turn,
				stored: [user("u1", "plan"), storedA],
				requestMessages: [user("u1", "a different text"), approvedA],
			}),
		);
		expect(r).toMatchObject({ outcome: "accept", kind: "continue" });
	});

	it("the same card approved in a second tab, after the first stored its output, is turn-answered without a claim", () => {
		const r = classifyTurn(
			input({
				turn,
				stored: [user("u1", "plan"), approvedA],
				requestMessages: [user("u1", "plan"), approvedA],
			}),
		);
		expect(r).toMatchObject({ outcome: "refuse", refusal: "turn-answered" });
	});

	it("a retry of a continuation whose claim exists keeps the stored outputs (retry mode)", () => {
		for (const state of ["failed", "expired", "running"] as const) {
			const claims: ClaimSnapshot[] = [{ attemptKey: key, state, partial: false }];
			const r = classifyTurn(
				input({
					turn,
					revision: 4,
					claims,
					stored: [user("u1", "plan"), approvedA],
					requestMessages: [user("u1", "plan"), approvedA],
				}),
			);
			expect(r).toMatchObject({ outcome: "accept", attemptKey: key, mode: "retry" });
		}
	});

	it("a continuation whose claim is answered and partial is resumed (C4r), not refused turn-answered", () => {
		// The continuation ran partially: a carries the approval's step and a partial tail.
		const partialA = assistant("a1", [
			...approvedA.parts,
			{ type: "step-start" },
			{ type: "text", text: "The plan is qu" },
		]);
		const claims: ClaimSnapshot[] = [{ attemptKey: key, state: "answered", partial: true }];
		const r = classifyTurn(
			input({
				turn,
				revision: 3,
				claims,
				stored: [user("u1", "plan"), partialA],
				requestMessages: [user("u1", "plan"), partialA],
			}),
		);
		expect(r).toMatchObject({ outcome: "accept", attemptKey: key, mode: "resume" });
	});

	it("an answered, complete continuation is a retry for the claim row to refuse (C4)", () => {
		const claims: ClaimSnapshot[] = [{ attemptKey: key, state: "answered", partial: false }];
		const r = classifyTurn(
			input({
				turn,
				claims,
				stored: [user("u1", "plan"), approvedA],
				requestMessages: [user("u1", "plan"), approvedA],
			}),
		);
		expect(r).toMatchObject({ outcome: "accept", mode: "retry" });
	});

	it("refuses turn-answered when the request does not match the stored answer", () => {
		const base = {
			turn,
			stored: [user("u1", "plan"), storedA],
			requestMessages: [user("u1", "plan"), approvedA],
		};
		// K ≠ P: the client named the server read too (revision 1's bug).
		expect(
			classifyTurn(input({ ...base, turn: { ...turn, toolCallIds: ["call-1", "read-1"] } })),
		).toMatchObject({ refusal: "turn-answered" });
		// No output for the proposal in the request.
		expect(
			classifyTurn(input({ ...base, requestMessages: [user("u1", "plan"), storedA] })),
		).toMatchObject({ refusal: "turn-answered" });
		// a is not the stored last message.
		expect(
			classifyTurn(
				input({ ...base, stored: [...base.stored, user("u2", "next")] }),
			),
		).toMatchObject({ refusal: "turn-answered" });
		// The first approval at a moved revision.
		expect(classifyTurn(input({ ...base, revision: 4 }))).toMatchObject({
			refusal: "turn-answered",
		});
		// A plain answer with no client tool: an empty P never matches vacuously.
		const plain = assistant("a1", [{ type: "text", text: "hi" }]);
		expect(
			classifyTurn(
				input({
					turn: { ...turn, toolCallIds: [] },
					stored: [user("u1", "plan"), plain],
					requestMessages: [user("u1", "plan"), plain],
				}),
			),
		).toMatchObject({ refusal: "turn-answered" });
	});

	it("CLIENT_TOOL_NAMES is the list the classifier reads", () => {
		expect(CLIENT_TOOL_NAMES).toEqual([
			"propose_operation",
			"create_support_case",
			"propose_changes",
		]);
	});
});
