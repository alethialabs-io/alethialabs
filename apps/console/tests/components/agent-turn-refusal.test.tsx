// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0003's client half (§9.1, §9.3; slices 6 and 9): the transport sends the turn fields an
// opted-in caller's server needs, Retry resends what is last (a turn, a continuation, or a
// regenerate of one named answer), and a typed refusal is answered by `onTurnRefused`: a refused
// SEND goes to the drafts store only (D9d, D10f, D20), and a refused regenerate or continuation,
// which no draft owns, loads the stored transcript and never puts words into the box.
//
// These drive the REAL `ElenchConversation`, the real `useAgentChat` (so the real `useChat` and
// `DefaultChatTransport`), the real `AgentChat`, the real Lexical composer and, since ADR 0001
// slice 9, the real drafts store every composer send goes through. Only the server is stubbed:
// the chat route at `fetch` (each test queues what it answers, and asserts on the bodies it was
// sent) and the draft actions, by the in-memory server of tests/fixtures/elench-drafts-server.ts.
//
// ADR 0001 slice 9 also owns ADR 0003 §9.3's ONE-HANDLER check and its C test, `One refusal
// handler`, at the end: a refusal of a send the store owns goes to the store and nowhere else.

import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	type ToolUIPart,
	type UIMessage,
	type UIMessageChunk,
} from "ai";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	getNearestEditorFromDOMNode,
	KEY_ENTER_COMMAND,
	type LexicalEditor,
} from "lexical";
import { type ReactNode, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ElenchThreadApi } from "@/components/agent/elench/elench-conversation";
import type { TurnRefusal } from "@/lib/agent/turn-claims";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	useParams: () => ({}),
	usePathname: () => "/acme",
}));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { id: "00000000-0000-4000-8000-0000000000aa" }, isPending: false }),
}));
// The real actions are server code; the drafts store here is handed the fake server's transport.
vi.mock("@/app/server/actions/elench-drafts", () => ({
	listDrafts: vi.fn(),
	saveDraft: vi.fn(),
	restoreDraft: vi.fn(),
	discardDraft: vi.fn(),
	claimDraft: vi.fn(),
	consumeDraft: vi.fn(),
	releaseClaim: vi.fn(),
	startConversation: vi.fn(),
}));
vi.mock("@/app/server/actions/billing", () => ({ getAiUsageSummary: vi.fn(async () => null) }));
vi.mock("@/app/server/actions/artifacts", () => ({
	openArtifactOnGrid: vi.fn(),
	syncArtifactWidgets: vi.fn(),
}));
vi.mock("@/app/server/actions/agent-feedback", () => ({
	getThreadFeedback: vi.fn(async () => ({})),
	setMessageFeedback: vi.fn(),
}));
const threadReads = vi.hoisted(() => ({ inFlight: [] as boolean[] }));
// What the stubbed approval card resolves with.
const card = vi.hoisted(() => ({ output: { status: "rejected" } as Record<string, unknown> }));
vi.mock("@/app/server/actions/agent", () => ({
	// "Being answered" polls this until the running claim is gone.
	getThread: vi.fn(async () => ({
		inFlight: threadReads.inFlight.shift() ? { turnId: "u1", since: new Date() } : null,
	})),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/app/server/actions/projects", () => ({
	getApprovedJob: vi.fn(async () => null),
	tryPlanProject: vi.fn(),
	tryProvisionProject: vi.fn(),
}));
vi.mock("@/components/agent/agent-artifact-gallery", () => ({ AgentArtifactGallery: () => null }));
vi.mock("@/components/agent/agent-knowledge-panel", () => ({ AgentKnowledgePanel: () => null }));
// The org tool lane: a proposal still awaiting its card renders one button that resolves it, as
// the approval card's Reject does; everything else renders nothing.
vi.mock("@/components/agent/render-tool-parts/org-tool-parts", () => ({
	orgRenderToolPart:
		({ addToolResult }: { addToolResult: (r: { tool: string; toolCallId: string; output: unknown }) => void }) =>
		(part: ToolUIPart) =>
			part.type === "tool-propose_operation" && part.state === "input-available" ? (
				<button
					type="button"
					onClick={() =>
						addToolResult({
							tool: "propose_operation",
							toolCallId: part.toolCallId,
							output: card.output,
						})
					}
				>
					Resolve card
				</button>
			) : null,
}));
vi.mock("@/components/agent/render-tool-parts/project-tool-parts", () => ({
	projectRenderToolPart: () => () => null,
}));
vi.mock("@/components/project-assistant/use-project-assistant", () => ({
	snapshotCanvas: () => null,
	snapshotView: () => null,
}));
vi.mock("@/components/agent/widgets/use-widget-auto-pin", () => ({ useWidgetAutoPin: () => {} }));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));
vi.mock("@/components/agent/elench/elench-controls", () => ({
	ElenchAskMode: () => null,
	ElenchDeepReasoning: () => null,
	ElenchModelButton: () => null,
}));
vi.mock("@/components/agent/elench/mention-typeahead", () => ({
	MentionTypeaheadPlugin: () => null,
}));
vi.mock("@/components/agent/elench/suggestion-carousel", () => ({
	SuggestionCarousel: () => null,
}));
vi.mock("@/components/agent/elench/elench-modal", () => ({
	ElenchModal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/agent/elench/elench-panel", () => ({
	ElenchPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { tryPlanProject } from "@/app/server/actions/projects";
import { ApprovalCard, fitClientToolText } from "@/components/agent/approval-card";
import { ElenchConversation } from "@/components/agent/elench/elench-conversation";
import { createDraftsTab, type DraftsTab, ElenchDraftsRoot } from "@/components/agent/elench/elench-drafts-root";
import { FakeElenchServer } from "@/tests/fixtures/elench-drafts-server";
import { parseClientToolOutput } from "@/lib/ai/client-tools";
import { turnOf, useAgentChat } from "@/components/agent/use-agent-chat";
import { classifyTurn } from "@/lib/agent/turn-key";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";

beforeAll(() => {
	// jsdom lacks Element.scrollTo — the message scroller calls it on content changes.
	Element.prototype.scrollTo ??= () => {};
});

const ORG = "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const THREAD = "7a2e3d4c-5b6f-4071-9b8c-0d1e2f3a4b5c";

// ── The route, stubbed at `fetch` ────────────────────────────────────────────────────────────

/** What one request answers: a typed refusal, or a UI message stream of `chunks`. */
type Answer = { refusal: TurnRefusal; status: number } | { chunks: UIMessageChunk[] };

const answers: Answer[] = [];
const bodies: unknown[] = [];

/** The parts of a request body these tests read. */
const sentSchema = z.object({
	messages: z.array(z.object({ id: z.string(), role: z.string() }).loose()),
	orgId: z.string().nullable().optional(),
	turn: z
		.object({
			trigger: z.string(),
			turnId: z.string(),
			baseRevision: z.number(),
			answerId: z.string().optional(),
			toolCallIds: z.array(z.string()).optional(),
		})
		.optional(),
});

/** The `n`-th body the route was sent, parsed. */
function sent(n: number) {
	return sentSchema.parse(bodies[n]);
}

/** A stream response of `chunks`, as `createUIMessageStreamResponse` writes it. */
function streamOf(chunks: UIMessageChunk[]): Response {
	return createUIMessageStreamResponse({
		stream: createUIMessageStream({
			execute: ({ writer }) => {
				for (const c of chunks) writer.write(c);
			},
		}),
	});
}

/** The stubbed `fetch`: records the body, answers with the next queued answer. */
async function routeFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
	const next = answers.shift();
	if (!next) throw new TypeError("Failed to fetch");
	if ("refusal" in next) {
		return new Response(JSON.stringify(next.refusal), {
			status: next.status,
			headers: { "content-type": "application/json" },
		});
	}
	return streamOf(next.chunks);
}

/** A refusal body (ADR 0003 §9.3). */
function refusal(code: TurnRefusal["refusal"], over: Partial<TurnRefusal> = {}): TurnRefusal {
	const committed = ["turn-in-progress", "turn-answered", "turn-committed-different-text", "turn-has-accepted-approval"].includes(code);
	return {
		refusal: code,
		turnId: null,
		committed,
		textCommitted: committed && code !== "turn-committed-different-text",
		answered: false,
		revision: 1,
		answerId: null,
		...over,
	};
}

/** An answer that streams `text` and finishes, reporting the stored revision. */
function answered(id: string, text: string, revision: number): UIMessageChunk[] {
	return [
		{ type: "data-turn-accepted", data: { turnId: "x", answerId: id, revision: revision - 1 }, transient: true },
		{ type: "start", messageId: id },
		{ type: "start-step" },
		{ type: "text-start", id: "t" },
		{ type: "text-delta", id: "t", delta: text },
		{ type: "text-end", id: "t" },
		{ type: "finish-step" },
		{ type: "data-turn-finished", data: { answerId: id, revision }, transient: true },
		{ type: "finish" },
	];
}

// ── The thread, as the server stores it ──────────────────────────────────────────────────────

const stored = { messages: [] as UIMessage[], revision: 1 };

const user = (id: string, text: string): UIMessage => ({
	id,
	role: "user",
	parts: [{ type: "text", text }],
});

/** An answer whose step proposes `propose_operation` call `callId`, optionally resolved. */
function proposal(id: string, callId: string, output?: Record<string, unknown>): UIMessage {
	const part: UIMessage["parts"][number] = output
		? {
				type: "tool-propose_operation",
				toolCallId: callId,
				state: "output-available",
				input: { label: "Plan api", operation: { operation: "plan_project", projectId: ORG } },
				output,
			}
		: {
				type: "tool-propose_operation",
				toolCallId: callId,
				state: "input-available",
				input: { label: "Plan api", operation: { operation: "plan_project", projectId: ORG } },
			};
	return { id, role: "assistant", parts: [{ type: "step-start" }, part] };
}

const reloads = vi.fn();

/** The conversation inside a harness that owns its transcript, as `useElenchThreads` does. */
function Harness({ initial, revision }: { initial: UIMessage[]; revision: number }) {
	const [messages, setMessages] = useState(initial);
	const [rev, setRev] = useState<number | null>(revision);
	const api: ElenchThreadApi = {
		ready: true,
		threads: [],
		activeId: THREAD,
		initialMessages: messages,
		initialRevision: rev,
		selectThread: vi.fn(),
		reloadThread: async (id: string) => {
			reloads(id);
			setMessages(stored.messages);
			setRev(stored.revision);
			useElenchStore.getState().selectThread(id);
		},
		newChat: vi.fn(),
		startThread: vi.fn(),
		deleteThread: vi.fn(),
	};
	return <ElenchConversation {...api} />;
}

// ── The drafts store every composer send goes through (ADR 0001 slice 9) ───────────────────────

let drafts: { server: FakeElenchServer; tab: DraftsTab };

/** A tab's drafts over the fake server, which knows THREAD as a stored thread (so sends are later turns). */
function newDrafts(): { server: FakeElenchServer; tab: DraftsTab } {
	const server = new FakeElenchServer();
	server.putThread({ id: THREAD, projectId: null, title: "t", messages: [user("s0", "stored")] });
	const tab = createDraftsTab({
		viewerId: "00000000-0000-4000-8000-0000000000aa",
		transport: server.transport(() => ORG),
		heartbeat: async () => Response.json({ outcome: "touched" }),
		storage: () => null,
		tabId: "tab-1",
		mint: () => crypto.randomUUID(),
	});
	return { server, tab };
}

/** Render the org conversation on `initial` (stored at `revision`), on its draft. */
async function renderConversation(initial: UIMessage[], revision: number) {
	stored.messages = initial;
	stored.revision = revision;
	useElenchStore.setState({
		open: true,
		view: "panel",
		ctx: { kind: "org" },
		threadId: THREAD,
		conversationId: THREAD,
		pageOrgId: ORG,
	});
	render(
		<ElenchDraftsRoot pageOrgId={ORG} tab={drafts.tab}>
			<Harness initial={initial} revision={revision} />
		</ElenchDraftsRoot>,
	);
	// The scope's first list, then the selection of THREAD's draft: the box is writable after it.
	await waitFor(() => expect(composerEditor().isEditable()).toBe(true));
}

// ── The composer ─────────────────────────────────────────────────────────────────────────────

/** The live Lexical editor behind the rendered composer. */
function composerEditor(): LexicalEditor {
	const editor = getNearestEditorFromDOMNode(screen.getByTestId("elench-composer"));
	if (!editor) throw new Error("the composer has no Lexical editor");
	return editor;
}

/** Replace the composer's content with `text`, as if the user typed it. */
function fill(text: string) {
	act(() => {
		composerEditor().update(
			() => {
				const root = $getRoot();
				root.clear();
				if (text) root.append($createParagraphNode().append($createTextNode(text)));
			},
			{ discrete: true },
		);
	});
}

/** The composer's current plain text. */
function content(): string {
	return composerEditor().getEditorState().read(() => $getRoot().getTextContent());
}

/** Press Enter in the composer — the user's own send. */
async function pressEnter() {
	await act(async () => {
		composerEditor().dispatchCommand(KEY_ENTER_COMMAND, null);
	});
}

/** Click the error card's Retry. */
async function clickRetry() {
	await userEvent.click(screen.getByRole("button", { name: /^retry$/i }));
}

const ERROR_CARD = "The assistant hit an error";

beforeEach(() => {
	drafts = newDrafts();
	answers.length = 0;
	bodies.length = 0;
	threadReads.inFlight = [];
	card.output = { status: "rejected" };
	reloads.mockClear();
	vi.stubGlobal("fetch", vi.fn(routeFetch));
	useWidgetGridStore.setState({
		hydrate: vi.fn(async () => undefined),
		reset: vi.fn(),
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// ── The transport (§9.1) ─────────────────────────────────────────────────────────────────────

describe("the transport's turn fields", () => {
	it("the request carries trigger, turnId, answerId, toolCallIds and baseRevision", async () => {
		await renderConversation([user("u1", "plan api"), proposal("a1", "call-1")], 4);
		answers.push({ chunks: answered("a1", "Rejected, so nothing was queued.", 6) });
		await userEvent.click(screen.getByRole("button", { name: "Resolve card" }));

		// The approval's auto-send is a continuation of a1 after its pending client tool call.
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(sent(0).orgId).toBe(ORG);
		expect(sent(0).turn).toEqual({
			trigger: "submit-message",
			turnId: "u1",
			baseRevision: 4,
			answerId: "a1",
			toolCallIds: ["call-1"],
		});

		// The next send carries the revision the route reported when it stored the answer.
		answers.push({ chunks: answered("a2", "ok", 8) });
		fill("next");
		await pressEnter();
		await waitFor(() => expect(bodies).toHaveLength(2));
		const second = sent(1);
		expect(second.turn?.trigger).toBe("submit-message");
		expect(second.turn?.turnId).toBe(second.messages.at(-1)?.id);
		expect(second.turn?.baseRevision).toBe(6);
		expect(second.turn?.answerId).toBeUndefined();

		// Regenerate names the answer it replaces.
		await waitFor(() => expect(screen.getByRole("button", { name: "Regenerate response" })).toBeTruthy());
		answers.push({ chunks: answered("a3", "again", 9) });
		await userEvent.click(screen.getByRole("button", { name: "Regenerate response" }));
		await waitFor(() => expect(bodies).toHaveLength(3));
		expect(sent(2).turn).toMatchObject({
			trigger: "regenerate-message",
			answerId: "a2",
			baseRevision: 8,
		});
	});

	it("a caller without `org` (the support chat) sends no orgId and no turn: its wire is unchanged", async () => {
		answers.push({ chunks: answered("a1", "ok", 2) });
		const { result } = renderHook(() => useAgentChat({ api: "/api/support/ask" }));
		await act(async () => {
			await result.current.sendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] });
		});
		await waitFor(() => expect(bodies).toHaveLength(1));
		const body = sentSchema.parse(bodies[0]);
		expect(body.messages.map((m) => m.id)).toEqual(["u1"]);
		expect(bodies[0]).not.toHaveProperty("orgId");
		expect(bodies[0]).not.toHaveProperty("turn");
	});

	it("before the page org is known the box has no draft to write to and Enter sends nothing; once it is, the send goes out with it", async () => {
		await renderConversation([user("u0", "hi"), { id: "a0", role: "assistant", parts: [{ type: "text", text: "hello" }] }], 3);
		act(() => useElenchStore.getState().setPageOrgId(null));
		await waitFor(() => expect(composerEditor().isEditable()).toBe(false));
		await pressEnter();
		expect(bodies).toHaveLength(0);
		expect(drafts.server.callsOf("claimDraft")).toHaveLength(0);

		// Once the shell has it, the box is the draft again and Enter goes out with the page's org.
		act(() => useElenchStore.getState().setPageOrgId(ORG));
		await waitFor(() => expect(composerEditor().isEditable()).toBe(true));
		fill("my question");
		answers.push({ chunks: answered("a1", "answered", 5) });
		await pressEnter();
		await waitFor(() => expect(bodies).toHaveLength(1));
		expect(sent(0).orgId).toBe(ORG);
	});

	it("U › turnOf over the client copy and the classifier over the stored answer derive the same key for a mixed step", () => {
		// One step: a server read (output stored) beside the proposal (output only in the client copy).
		const read: UIMessage["parts"][number] = {
			type: "tool-list_projects",
			toolCallId: "read-1",
			state: "output-available",
			input: {},
			output: { projects: [] },
		};
		const storedA: UIMessage = { ...proposal("a1", "call-1"), parts: [{ type: "step-start" }, read, proposal("a1", "call-1").parts[1]] };
		const clientA: UIMessage = {
			...storedA,
			parts: [{ type: "step-start" }, read, proposal("a1", "call-1", { status: "rejected" }).parts[1]],
		};
		const u = user("u1", "plan api");
		const turn = turnOf([u, clientA], "submit-message", "a1", 3);
		expect(turn.toolCallIds).toEqual(["call-1"]);
		const cls = classifyTurn({ turn, requestMessages: [u, clientA], stored: [u, storedA], revision: 3, claims: [] });
		expect(cls).toMatchObject({ outcome: "accept", kind: "continue", attemptKey: "continue:a1:call-1" });
	});
});

// ── Retry (§9.1) ─────────────────────────────────────────────────────────────────────────────

describe("Retry resends what is last", () => {
	it("Retry on a failed continuation resends the continuation, not regenerate()", async () => {
		await renderConversation([user("u1", "plan api"), proposal("a1", "call-1")], 2);
		// The continuation fails before the route answers.
		await userEvent.click(screen.getByRole("button", { name: "Resolve card" }));
		expect(await screen.findByText(ERROR_CARD)).toBeTruthy();

		answers.push({ chunks: answered("a1", "done", 4) });
		await clickRetry();
		await waitFor(() => expect(bodies).toHaveLength(2));
		expect(sent(1).turn).toMatchObject({ trigger: "submit-message", answerId: "a1", toolCallIds: ["call-1"] });
		expect(sent(1).messages.at(-1)?.id).toBe("a1");
	});

	it("Retry on a partial continuation resends the continuation, and Regenerate is not shown on an answer with an accepted approval", async () => {
		card.output = { status: "approved", operation: "plan_project", projectId: ORG, environmentId: null, jobId: THREAD };
		await renderConversation([user("u1", "plan api"), proposal("a1", "call-1")], 3);
		// The approval's continuation streams a tail, then fails: partial after the approval.
		answers.push({
			chunks: [
				{ type: "start", messageId: "a1" },
				{ type: "start-step" },
				{ type: "text-start", id: "t" },
				{ type: "text-delta", id: "t", delta: "The plan is queued and" },
				{ type: "error", errorText: "provider error" },
			],
		});
		await userEvent.click(screen.getByRole("button", { name: "Resolve card" }));
		expect(await screen.findByText(ERROR_CARD)).toBeTruthy();
		expect(screen.getByText("The plan is queued and")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Regenerate response" })).toBeNull();

		answers.push({ chunks: answered("a1", " it is done.", 5) });
		await clickRetry();
		await waitFor(() => expect(bodies).toHaveLength(2));
		expect(sent(1).turn).toMatchObject({ trigger: "submit-message", answerId: "a1", toolCallIds: ["call-1"] });
		expect(sent(1).messages.at(-1)?.id).toBe("a1");
	});

	it("Retry after a partial answer with no client tool output is regenerate({ messageId })", async () => {
		await renderConversation([user("u0", "hi"), { id: "a0", role: "assistant", parts: [{ type: "text", text: "hello" }] }], 3);
		answers.push({
			chunks: [
				{ type: "start", messageId: "a1" },
				{ type: "start-step" },
				{ type: "text-start", id: "t" },
				{ type: "text-delta", id: "t", delta: "Half an ans" },
				{ type: "error", errorText: "provider error" },
			],
		});
		fill("status?");
		await pressEnter();
		await screen.findByText(ERROR_CARD);

		answers.push({ chunks: answered("a2", "whole", 6) });
		await clickRetry();
		await waitFor(() => expect(bodies).toHaveLength(2));
		expect(sent(1).turn).toMatchObject({ trigger: "regenerate-message", answerId: "a1" });
	});

	it("a partial continuation whose tail holds an unanswered proposal offers no Retry and says to approve or reject it", async () => {
		await renderConversation([user("u1", "plan api"), proposal("a1", "call-1")], 2);
		answers.push({
			chunks: [
				{ type: "start", messageId: "a1" },
				{ type: "start-step" },
				{ type: "tool-input-available", toolCallId: "call-2", toolName: "propose_operation", input: { label: "Deploy api" } },
				{ type: "finish-step" },
				{ type: "error", errorText: "provider error" },
			],
		});
		await userEvent.click(screen.getByRole("button", { name: "Resolve card" }));
		expect(await screen.findByText("Approve or reject the proposal above to continue.")).toBeTruthy();
		expect(screen.queryByRole("button", { name: /^retry$/i })).toBeNull();
	});
});

// ── Refusals (§9.3) ──────────────────────────────────────────────────────────────────────────

describe("onTurnRefused", () => {
	it("turn-answered loads the transcript and shows no error card", async () => {
		await renderConversation([user("u1", "plan api")], 2);
		expect(screen.getByText("No reply arrived")).toBeTruthy();
		stored.messages = [user("u1", "plan api"), { id: "a1", role: "assistant", parts: [{ type: "text", text: "answered elsewhere" }] }];
		stored.revision = 3;
		answers.push({ refusal: refusal("turn-answered", { turnId: "u1", answered: true, revision: 3 }), status: 409 });
		await clickRetry();

		expect(await screen.findByText("answered elsewhere")).toBeTruthy();
		expect(reloads).toHaveBeenCalledWith(THREAD);
		expect(screen.queryByText(ERROR_CARD)).toBeNull();
		expect(screen.queryByText("No reply arrived")).toBeNull();
	});

	it("transcript-stale (a store-owned send) reloads the transcript, puts the text back, shows no error card, and the next Enter is accepted", async () => {
		await renderConversation([user("u0", "hi"), { id: "a0", role: "assistant", parts: [{ type: "text", text: "hello" }] }], 3);
		stored.messages = [
			...stored.messages,
			user("u9", "from the other tab"),
			{ id: "a9", role: "assistant", parts: [{ type: "text", text: "newer answer" }] },
		];
		stored.revision = 5;
		answers.push({ refusal: refusal("transcript-stale", { revision: 5 }), status: 409 });
		fill("my question");
		await pressEnter();

		expect(await screen.findByText("newer answer")).toBeTruthy();
		expect(screen.queryByText(ERROR_CARD)).toBeNull();
		await waitFor(() => expect(content()).toBe("my question"));
		// D9d (a): released as a certain refusal, never "may already have been sent".
		expect(drafts.server.callsOf("releaseClaim")).toMatchObject([{ error: "transcript-stale", uncertain: false }]);

		answers.push({ chunks: answered("a10", "answered now", 7) });
		await pressEnter();
		await waitFor(() => expect(bodies).toHaveLength(2));
		expect(sent(1).turn?.baseRevision).toBe(5);
		expect(await screen.findByText("answered now")).toBeTruthy();
	});

	it("turn-committed-different-text (a store-owned send) keeps the edit in the composer under a fresh turn id", async () => {
		await renderConversation([user("u1", "deploy staging")], 2);
		answers.push({
			refusal: refusal("turn-committed-different-text", { turnId: "u1", revision: 2 }),
			status: 409,
		});
		fill("deploy staging, but skip the migration");
		await pressEnter();

		await waitFor(() => expect(content()).toBe("deploy staging, but skip the migration"));
		const [release] = drafts.server.callsOf("releaseClaim") as { freshTurnId?: string }[];
		expect(release?.freshTurnId).toEqual(expect.any(String));
		expect(screen.queryByText(ERROR_CARD)).toBeNull();
	});

	it("turn-in-progress shows Being answered and reloads when inFlight clears", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		await renderConversation([user("u1", "plan api")], 2);
		answers.push({ refusal: refusal("turn-in-progress", { turnId: "u1", revision: 2 }), status: 409 });
		await clickRetry();

		expect(await screen.findByText("Being answered in another tab or device")).toBeTruthy();
		expect(screen.queryByText("No reply arrived")).toBeNull();
		const before = reloads.mock.calls.length;
		threadReads.inFlight = [true, false];
		stored.messages = [user("u1", "plan api"), { id: "a1", role: "assistant", parts: [{ type: "text", text: "the other tab's answer" }] }];
		stored.revision = 3;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(reloads.mock.calls.length).toBe(before);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		await waitFor(() => expect(reloads.mock.calls.length).toBe(before + 1));
		expect(await screen.findByText("the other tab's answer")).toBeTruthy();
		expect(screen.queryByText("Being answered in another tab or device")).toBeNull();
	});

	it("turn-in-progress of a store-owned send consumes the draft, shows Being answered, polls getThread.inFlight, and reloads when it clears", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		await renderConversation([user("u0", "hi"), { id: "a0", role: "assistant", parts: [{ type: "text", text: "hello" }] }], 3);
		answers.push({ refusal: refusal("turn-in-progress", { revision: 4 }), status: 409 });
		fill("plan api");
		await pressEnter();

		// D20 through the store: the turn is committed with this text, so the draft is consumed, the
		// transcript loaded, and the status line is the store's own.
		await waitFor(() => expect(drafts.server.callsOf("consumeDraft")).toHaveLength(1));
		const said = await screen.findByText("Being answered in another tab or device");
		expect(said.closest('[data-testid="elench-draft-status"]')).not.toBeNull();
		expect(screen.queryByText(ERROR_CARD)).toBeNull();
		expect(drafts.server.callsOf("releaseClaim")).toHaveLength(0);
		const before = reloads.mock.calls.length;
		threadReads.inFlight = [true, false];
		stored.messages = [...stored.messages, { id: "a9", role: "assistant", parts: [{ type: "text", text: "the other tab's answer" }] }];
		stored.revision = 5;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		expect(reloads.mock.calls.length).toBe(before); // still in flight: polled, not loaded
		await act(async () => {
			await vi.advanceTimersByTimeAsync(5_000);
		});
		await waitFor(() => expect(reloads.mock.calls.length).toBe(before + 1));
		expect(await screen.findByText("the other tab's answer")).toBeTruthy();
		expect(screen.queryByText("Being answered in another tab or device")).toBeNull();
	});

	it("a refused Retry (a regenerate, which no draft owns) loads the transcript and puts nothing into the box", async () => {
		await renderConversation([user("u1", "plan api")], 2);
		answers.push({ refusal: refusal("thread-busy", { turnId: "u1", revision: 2 }), status: 409 });
		await clickRetry();

		await waitFor(() => expect(reloads).toHaveBeenCalledWith(THREAD));
		expect(await screen.findByText("Another message in this conversation is being answered")).toBeTruthy();
		// Give a restore every chance to land: the stored turn's words must not come back as a new draft.
		await act(async () => {});
		await act(async () => {});
		expect(content()).toBe("");
		expect(drafts.server.callsOf("claimDraft")).toHaveLength(0);
		expect(drafts.server.callsOf("releaseClaim")).toHaveLength(0);
	});

	it("a continuation refused turn-answered with a newer revision loads, keeps the card and Retry, and the next Retry is accepted as a resume", async () => {
		const rejected = { status: "rejected" };
		await renderConversation([user("u1", "plan api"), proposal("a1", "call-1")], 4);
		// The approval was stored by an earlier attempt that ended partial; this tab is one behind.
		stored.messages = [user("u1", "plan api"), proposal("a1", "call-1", rejected)];
		stored.revision = 6;
		answers.push({ refusal: refusal("turn-answered", { turnId: "u1", answered: true, revision: 6, answerId: "a1" }), status: 409 });
		await userEvent.click(screen.getByRole("button", { name: "Resolve card" }));

		expect(await screen.findByText(/changed while the answer was being continued/)).toBeTruthy();
		expect(reloads).toHaveBeenCalled();
		answers.push({ chunks: answered("a1", "resumed", 7) });
		await clickRetry();
		await waitFor(() => expect(bodies).toHaveLength(2));
		expect(sent(1).turn).toMatchObject({
			trigger: "submit-message",
			answerId: "a1",
			toolCallIds: ["call-1"],
			baseRevision: 6,
		});
	});
});

// ── ADR 0003 §9.3's one-handler check (ADR 0001 slice 9) ────────────────────────────────────

describe("ADR 0003 §9.3's one-handler check", () => {
	// ADR 0003's C test of this name: a refusal of a send the drafts store owns goes to the store
	// only, so its words come back once.
	it("One refusal handler", async () => {
		await renderConversation([user("u0", "hi"), { id: "a0", role: "assistant", parts: [{ type: "text", text: "hello" }] }], 3);
		answers.push({ refusal: refusal("thread-busy", { revision: 3 }), status: 409 });
		fill("one copy only");
		await pressEnter();
		await waitFor(() => expect(drafts.server.callsOf("releaseClaim")).toHaveLength(1));
		await waitFor(() => expect(content()).toBe("one copy only"));
		// Give a second handler every chance to run: it would reload again, say so in its own status
		// line, and put the words back a second time.
		await act(async () => {});
		await act(async () => {});
		expect(content()).toBe("one copy only");
		expect(reloads).toHaveBeenCalledTimes(1); // the store's own load (D9d (a), thread-busy)
		// The reason is said once, by the store's own status line; the composer path's line is absent.
		const said = screen.queryAllByText("Another message in this conversation is being answered");
		expect(said).toHaveLength(1);
		expect(said[0]?.closest('[data-testid="elench-draft-status"]')).not.toBeNull();
		expect(drafts.server.row({ orgId: ORG, projectId: null, conversationId: THREAD })?.content.text).toBe("one copy only");
	});

	it("a refusal of a request the store does not own (a Retry, which regenerates) loads the transcript and touches no draft", async () => {
		await renderConversation([user("u1", "plan api")], 2);
		stored.messages = [user("u1", "plan api"), { id: "a1", role: "assistant", parts: [{ type: "text", text: "answered elsewhere" }] }];
		stored.revision = 3;
		answers.push({ refusal: refusal("turn-answered", { turnId: "u1", answered: true, revision: 3 }), status: 409 });
		await clickRetry();
		expect(await screen.findByText("answered elsewhere")).toBeTruthy();
		expect(reloads).toHaveBeenCalledWith(THREAD);
		expect(drafts.server.callsOf("claimDraft")).toHaveLength(0);
		expect(drafts.server.callsOf("releaseClaim")).toHaveLength(0);
		expect(content()).toBe("");
	});
});

// ── The approval cards' free text (§5.1 step 8) ──────────────────────────────────────────────

describe("client-side truncation", () => {
	it("a denied reason longer than the cap is truncated so the continuation is accepted", async () => {
		// The gate's sentence, far over both the 2,000-character and the 4,096-byte bound.
		vi.mocked(tryPlanProject).mockResolvedValue({ ok: false, error: "é".repeat(5_000) });
		const onResolve = vi.fn();
		render(
			<ApprovalCard
				proposal={{
					id: "call-1",
					label: "Plan api",
					operation: { operation: "plan_project", projectId: ORG },
				}}
				onResolve={onResolve}
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: /approve/i }));
		await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
		const output: unknown = onResolve.mock.calls[0]?.[0];
		expect(parseClientToolOutput("propose_operation", output).ok).toBe(true);
		expect(output).toMatchObject({ status: "denied", reason: expect.stringMatching(/^é+…$/) });
	});

	it("cuts each card's free text at a code point, and leaves text that fits untouched", () => {
		const support = (r: string) => ({ status: "failed", reason: r });
		const label = (l: string) => ({ status: "accepted", label: l });
		expect(fitClientToolText("create_support_case", "short", support)).toBe("short");
		// Astral characters: a cut between surrogate halves would not be valid text.
		const cut = fitClientToolText("propose_changes", "🚀".repeat(3_000), label);
		expect(parseClientToolOutput("propose_changes", label(cut)).ok).toBe(true);
		expect(cut.endsWith("…")).toBe(true);
		expect(cut.slice(0, -1)).toBe("🚀".repeat(Array.from(cut).length - 1));
		const reason = fitClientToolText("create_support_case", "x".repeat(9_000), support);
		expect(parseClientToolOutput("create_support_case", support(reason)).ok).toBe(true);
		expect(reason.length).toBe(2_000);
	});
});
