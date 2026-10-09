// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A user's message is never lost silently (maintainer ruling, #5423 review). When a first send
// cannot create its thread, nothing is sent and the composer keeps the text — still editable.
// Retry used to re-send the FAILED attempt's snapshot (`pending.text`) and then remount the
// docked composer (or, on the modal landing, unmount it along with the landing): an edit made
// after the failure was neither sent nor kept, and nothing said so. Retry is now the composer's
// own submit — exactly Enter. These tests drive the real `ElenchConversation`, the real
// `useElenchSend` and the real Lexical composer; the chat transport, the transcript renderer and
// the chrome are stubbed (the transcript stub renders the conversation's own `ChatError`, so the
// card, its copy and its Retry are the real ones).

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UIMessage } from "ai";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	getNearestEditorFromDOMNode,
	KEY_ENTER_COMMAND,
	type LexicalEditor,
} from "lexical";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirstTurn } from "@/app/server/actions/agent";
import type { ElenchThreadApi } from "@/components/agent/elench/elench-conversation";
import type { AgentThread } from "@/lib/db/schema";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	useParams: () => ({}),
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
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/components/agent/agent-artifact-gallery", () => ({ AgentArtifactGallery: () => null }));
vi.mock("@/components/agent/agent-knowledge-panel", () => ({ AgentKnowledgePanel: () => null }));
vi.mock("@/components/agent/render-tool-parts/org-tool-parts", () => ({
	orgRenderToolPart: () => () => null,
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

// The transport: `sendMessage` appends to a real transcript (so the modal landing unmounts on a
// send, as it does in the product), and `transportError` stands in for the chat's own error.
interface ChatHarness {
	sent: UIMessage[];
	transportError: Error | undefined;
	regenerate: (options?: { messageId?: string }) => void;
}
const chat = vi.hoisted(
	(): ChatHarness => ({ sent: [], transportError: undefined, regenerate: () => undefined }),
);
vi.mock("@/components/agent/use-agent-chat", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/components/agent/use-agent-chat")>()),
	useAgentChat: ({ initialMessages }: { initialMessages: UIMessage[] }) => {
		const [messages, setMessages] = useState<UIMessage[]>(initialMessages);
		return {
			messages,
			status: "ready",
			error: chat.transportError,
			sendMessage: (m: UIMessage) => {
				chat.sent.push(m);
				setMessages((prev) => [...prev, m]);
			},
			regenerate: (options?: { messageId?: string }) => chat.regenerate(options),
			stop: () => undefined,
			addToolResult: () => undefined,
			clearError: () => undefined,
			setBaseRevision: () => undefined,
		};
	},
}));

// The transcript renderer: the conversation's error card + composer + empty state, nothing else.
vi.mock("@/components/agent/agent-chat", async () => {
	const { ChatError } = await import("@/components/agent/chat-error");
	return {
		AgentChat: (props: {
			error?: Error;
			onRetry?: () => void;
			renderComposer?: ReactNode;
			emptyState?: ReactNode;
		}) => (
			<div data-testid="agent-chat">
				{props.emptyState}
				{props.error && <ChatError error={props.error} onRetry={props.onRetry} />}
				{props.renderComposer}
			</div>
		),
	};
});

import { ElenchConversation } from "@/components/agent/elench/elench-conversation";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";

/** The live Lexical editor behind the (one) rendered composer. */
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

/** Click the error card's Retry and let the send settle. */
async function clickRetry() {
	await userEvent.click(screen.getByRole("button", { name: /retry/i }));
}

const THREAD_START_TITLE = "Could not start the conversation";

/**
 * Render the conversation in `view` with a `startThread` that fails `failures` times and then
 * attaches a thread (as the real one does, through the store).
 */
function renderConversation(opts: {
	view: "modal" | "panel";
	failures: number;
	initialMessages?: UIMessage[];
}) {
	let left = opts.failures;
	const startThread = vi.fn(async (title: string, _turn?: FirstTurn): Promise<AgentThread> => {
		if (left > 0) {
			left -= 1;
			throw new Error("insert failed");
		}
		useElenchStore.getState().attachThread("t-1");
		const now = new Date();
		return {
			id: "t-1",
			user_id: "u",
			org_id: "u",
			project_id: null,
			title,
			status: "active",
			kind: "agent",
			messages: [],
			billing_org_id: null,
			revision: 1,
			created_at: now,
			updated_at: now,
		} satisfies AgentThread;
	});
	useElenchStore.setState({ view: opts.view, ctx: { kind: "org" }, threadId: null });
	const api: ElenchThreadApi = {
		ready: true,
		threads: [],
		activeId: null,
		initialMessages: opts.initialMessages ?? [],
		selectThread: vi.fn(),
		newChat: vi.fn(),
		startThread,
		deleteThread: vi.fn(),
	};
	render(<ElenchConversation {...api} />);
	return { startThread };
}

beforeEach(() => {
	chat.sent.length = 0;
	chat.transportError = undefined;
	chat.regenerate = () => undefined;
	useWidgetGridStore.setState({
		hydrate: vi.fn(async () => undefined),
		reset: vi.fn(),
	});
});

describe.each(["panel", "modal"] as const)("ElenchConversation (%s) — Retry after a failed thread start", (view) => {
	it("shows the failure as the thread-start card and keeps the text in the composer", async () => {
		renderConversation({ view, failures: 1 });
		fill("deploy staging");
		await pressEnter();
		expect(await screen.findByText(THREAD_START_TITLE)).toBeTruthy();
		expect(content()).toBe("deploy staging");
		expect(chat.sent).toHaveLength(0);
	});

	it("sends the EDITED text on Retry, under the same first-turn id, and clears only after it went out", async () => {
		const { startThread } = renderConversation({ view, failures: 1 });
		fill("deploy staging");
		await pressEnter();
		await screen.findByText(THREAD_START_TITLE);

		fill("deploy staging, but skip the db migration");
		await clickRetry();

		await waitFor(() => expect(chat.sent).toHaveLength(1));
		const edited = "deploy staging, but skip the db migration";
		expect(chat.sent[0].parts).toEqual([{ type: "text", text: edited }]);
		expect(startThread).toHaveBeenCalledTimes(2);
		const [, firstTurn] = startThread.mock.calls[0];
		const [retryTitle, retryTurn] = startThread.mock.calls[1];
		expect(retryTitle).toBe(edited);
		expect(retryTurn).toEqual({ id: firstTurn?.id, text: edited });
		expect(chat.sent[0].id).toBe(firstTurn?.id);
		expect(screen.queryByText(THREAD_START_TITLE)).toBeNull();
		// What is in the box now is the docked composer after a send that went out: empty. (On
		// the modal the landing gave way to the transcript; its composer held exactly what was
		// sent.)
		expect(content()).toBe("");
	});

	it("keeps the edited text when the Retry fails too", async () => {
		const { startThread } = renderConversation({ view, failures: 2 });
		fill("deploy staging");
		await pressEnter();
		await screen.findByText(THREAD_START_TITLE);

		fill("deploy staging, edited");
		await clickRetry();

		await waitFor(() => expect(startThread).toHaveBeenCalledTimes(2));
		expect(chat.sent).toHaveLength(0);
		expect(screen.getByText(THREAD_START_TITLE)).toBeTruthy();
		expect(content()).toBe("deploy staging, edited");
	});

	it("puts a typed failed turn back into an emptied composer and sends nothing", async () => {
		const { startThread } = renderConversation({ view, failures: 1 });
		fill("deploy staging");
		await pressEnter();
		await screen.findByText(THREAD_START_TITLE);

		// The user emptied the box: Retry must not send words they just erased.
		fill("");
		await clickRetry();

		await waitFor(() => expect(content()).toBe("deploy staging"));
		expect(chat.sent).toHaveLength(0);
		expect(startThread).toHaveBeenCalledTimes(1);
		expect(screen.getByText(THREAD_START_TITLE)).toBeTruthy();

		// Now the box holds it, so the next Retry sends it.
		await clickRetry();
		await waitFor(() => expect(chat.sent).toHaveLength(1));
		expect(chat.sent[0].parts).toEqual([{ type: "text", text: "deploy staging" }]);
	});

	it("re-sends a failed seed prompt (it never lived in the composer) when the box is empty", async () => {
		const { startThread } = renderConversation({ view, failures: 1 });
		act(() => useElenchStore.getState().setSeedPrompt("summarise my clusters"));
		await screen.findByText(THREAD_START_TITLE);
		expect(content()).toBe("");

		await clickRetry();

		await waitFor(() => expect(chat.sent).toHaveLength(1));
		expect(startThread).toHaveBeenCalledTimes(2);
		expect(chat.sent[0].parts).toEqual([{ type: "text", text: "summarise my clusters" }]);
	});
});

// A minimize or maximize remounts the composer (ElenchModal and ElenchPanel each wrap the body;
// in the modal an empty conversation is the landing, with its own composer). The remounted
// composer starts from the failed turn, so the box shows what Retry sends. An edit made AFTER
// the failure and before the flip is not kept — a remount loses unsent text exactly as it does
// on dev; keeping it is the draft redesign (#5464).
describe.each([
	["modal", "minimize"],
	["panel", "maximize"],
] as const)("ElenchConversation (%s) — a %s after a failed thread start", (view, flip) => {
	it("remounts the composer holding the failed turn, and Retry sends exactly what it shows", async () => {
		const { startThread } = renderConversation({ view, failures: 1 });
		fill("deploy staging");
		await pressEnter();
		await screen.findByText(THREAD_START_TITLE);
		fill("deploy staging, EDITED");

		act(() => useElenchStore.getState()[flip]());

		expect(screen.getByText(THREAD_START_TITLE)).toBeTruthy();
		await waitFor(() => expect(content()).toBe("deploy staging"));
		await clickRetry();

		await waitFor(() => expect(chat.sent).toHaveLength(1));
		expect(chat.sent[0].parts).toEqual([{ type: "text", text: "deploy staging" }]);
		expect(startThread).toHaveBeenCalledTimes(2);
		expect(chat.sent[0].id).toBe(startThread.mock.calls[0][1]?.id);
	});

	it("a composer mounted with no failed send pending starts empty", async () => {
		renderConversation({ view, failures: 0 });
		act(() => useElenchStore.getState()[flip]());
		expect(content()).toBe("");
	});
});

describe("ElenchConversation — which error the transcript shows", () => {
	it("a failed send takes precedence over the transcript's error, and its Retry is the thread re-attempt", async () => {
		// The transcript ends on a plain answer, so its own Retry regenerates THAT answer (§9.1).
		const regenerate = vi.fn();
		chat.regenerate = regenerate;
		chat.transportError = new TypeError("Failed to fetch");
		const earlier: UIMessage[] = [
			{ id: "u0", role: "user", parts: [{ type: "text", text: "earlier" }] },
			{ id: "a0", role: "assistant", parts: [{ type: "text", text: "reply" }] },
		];
		const { startThread } = renderConversation({
			view: "panel",
			failures: 1,
			initialMessages: earlier,
		});
		// Before any failed send: the transcript's own error, whose Retry regenerates.
		expect(screen.getByText("The assistant hit an error")).toBeTruthy();
		await clickRetry();
		expect(regenerate).toHaveBeenCalledTimes(1);
		expect(regenerate).toHaveBeenCalledWith({ messageId: "a0" });

		fill("next question");
		await pressEnter();
		expect(await screen.findByText(THREAD_START_TITLE)).toBeTruthy();
		expect(screen.queryByText("The assistant hit an error")).toBeNull();

		await clickRetry();
		await waitFor(() => expect(startThread).toHaveBeenCalledTimes(2));
		expect(regenerate).toHaveBeenCalledTimes(1);
		expect(chat.sent.at(-1)?.parts).toEqual([{ type: "text", text: "next question" }]);
	});

	it("the modal landing shows a failed send as its notice, above a composer that still holds the text", async () => {
		renderConversation({ view: "modal", failures: 1 });
		fill("hello");
		await pressEnter();
		expect(await screen.findByText(THREAD_START_TITLE)).toBeTruthy();
		// Still the landing: nothing was sent, so the transcript never replaced it.
		expect(screen.queryByTestId("agent-chat")).toBeNull();
		expect(screen.getByText("What should we do today?")).toBeTruthy();
		expect(content()).toBe("hello");
	});
});
