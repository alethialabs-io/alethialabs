// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0001 slice 9, the S9 surface tests (§11): the composer and the conversation on the drafts
// store. These drive the REAL drafts root, `ElenchSurface`, `useElenchThreads`,
// `ElenchConversation`, the real store (reducer, queue, cache, heartbeat) and the real Lexical
// composer, with `useAgentChat`'s real `useChat`. Only the server is faked: the draft actions with
// real compare-and-set semantics, the threads, the chat routes and the heartbeat route
// (tests/fixtures/elench-drafts-server.ts). Every clock is a fake timer.
//
// "Reload" is a fresh tab over the same `sessionStorage` and the same server. Which conversation a
// reloaded tab resumes is slice 10's; these tests open the conversation they are about themselves.

import { act, cleanup, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import {
	$createLineBreakNode,
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	getNearestEditorFromDOMNode,
	KEY_ENTER_COMMAND,
	type LexicalEditor,
	type LexicalNode,
} from "lexical";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElenchServer } from "@/tests/fixtures/elench-drafts-server";

const nav = vi.hoisted(() => ({ pathname: "/acme" }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	usePathname: () => nav.pathname,
	useParams: () => ({}),
}));
const who = vi.hoisted(() => ({ viewer: { id: "00000000-0000-4000-8000-0000000000aa" } as { id: string } | null }));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: who.viewer, isPending: false }),
}));
// The real actions are server code; every tab here is handed the fake server's transport.
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
const srv = vi.hoisted(() => ({ current: null as FakeElenchServer | null }));
vi.mock("@/app/server/actions/agent", () => ({
	listThreads: vi.fn(async (projectId?: string) => srv.current?.listThreads(projectId) ?? []),
	getThread: vi.fn(async (id: string) => srv.current?.getThread(id) ?? null),
	createThread: vi.fn(),
	deleteThread: vi.fn(async (id: string) => srv.current?.deleteThread(id)),
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
vi.mock("@/app/server/actions/projects", () => ({
	getApprovedJob: vi.fn(async () => null),
	tryPlanProject: vi.fn(),
	tryProvisionProject: vi.fn(),
}));
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
	SuggestionCarousel: ({ onSelect }: { onSelect: (prompt: string) => void }) => (
		<button type="button" onClick={() => onSelect("Show my clusters")}>
			Suggestion
		</button>
	),
}));
vi.mock("@/components/agent/elench/elench-modal", () => ({
	ElenchModal: ({ children }: { children: ReactNode }) => <div data-testid="modal">{children}</div>,
}));
vi.mock("@/components/agent/elench/elench-panel", () => ({
	ElenchPanel: ({ children }: { children: ReactNode }) => <div data-testid="panel">{children}</div>,
}));

import { createDraftsTab, type DraftsTab, ElenchDraftsRoot } from "@/components/agent/elench/elench-drafts-root";
import { ElenchSurface } from "@/components/agent/elench/elench-surface";
import { keyId } from "@/lib/stores/elench-drafts/reducer-drafting";
import type { DraftKey } from "@/lib/stores/elench-drafts/types";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";

const VIEWER = "00000000-0000-4000-8000-0000000000aa";
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

const INITIAL = useElenchStore.getState();

beforeAll(() => {
	// jsdom lacks Element.scrollTo — the message scroller calls it on content changes.
	Element.prototype.scrollTo ??= () => {};
	// …and Range's geometry, which Lexical reads when it moves the caret after a reseed.
	Range.prototype.getBoundingClientRect ??= () => new DOMRect();
	Range.prototype.getClientRects ??= () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
});

// ── The harness ──────────────────────────────────────────────────────────────────────────────

let server: FakeElenchServer;

/** One browser tab: its drafts over the fake server, posting from the page `page.org`. */
interface Tab {
	drafts: DraftsTab;
	page: { org: string };
	storage: Storage;
}

/** A storage over a plain map, so a "reload" can keep it and a test can make it throw. */
function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => items.clear(),
		getItem: (k) => items.get(k) ?? null,
		key: (i) => [...items.keys()][i] ?? null,
		removeItem: (k) => void items.delete(k),
		setItem: (k, v) => void items.set(k, v),
	};
}

/** A new tab (or a reload of one: pass its storage) of `org`. */
function newTab(org: string, storage: Storage = memoryStorage(), getStorage?: () => Storage | null): Tab {
	const page = { org };
	const drafts = createDraftsTab({
		viewerId: VIEWER,
		transport: server.transport(() => page.org),
		heartbeat: (body, signal) =>
			server.fetch("/api/elench/drafts/heartbeat", { method: "POST", body: JSON.stringify(body), signal }),
		storage: getStorage ?? (() => storage),
		tabId: crypto.randomUUID(),
		mint: () => crypto.randomUUID(),
	});
	return { drafts, page, storage };
}

/** Lets every pending promise, render and timer due within `ms` run. */
async function flush(ms = 0): Promise<void> {
	for (let i = 0; i < 4; i++) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(i === 0 ? ms : 0);
		});
	}
}

/** Renders the shell's Elench part for `tab`, opened in `view`; resolves once the list settled. */
async function mount(tab: Tab, view: "modal" | "panel" = "panel"): Promise<() => void> {
	useElenchStore.setState({ pageOrgId: tab.page.org });
	const r = render(
		<ElenchDraftsRoot pageOrgId={tab.page.org} tab={tab.drafts}>
			<ElenchSurface />
		</ElenchDraftsRoot>,
	);
	act(() => {
		if (view === "modal") useElenchStore.getState().openModal({ kind: "org" });
		else useElenchStore.getState().openPanel({ kind: "org" });
	});
	await flush();
	return () => r.unmount();
}

/** Reloads: the page's memory is gone, its `sessionStorage` and the server are not. */
async function reload(tab: Tab, unmount: () => void, open?: string): Promise<{ tab: Tab; unmount: () => void }> {
	act(() => {
		window.dispatchEvent(new Event("pagehide")); // the cache is written synchronously on leave (§7.5)
	});
	unmount();
	tab.drafts.store.dispose(); // the page's memory, timers and listeners are gone
	cleanup();
	useElenchStore.setState({ ...INITIAL, conversationId: open ?? crypto.randomUUID() });
	const next = newTab(tab.page.org, tab.storage);
	return { tab: next, unmount: await mount(next) };
}

/** The live Lexical editor behind the rendered composer. */
function editor(): LexicalEditor {
	const e = getNearestEditorFromDOMNode(screen.getByTestId("elench-composer"));
	if (!e) throw new Error("the composer has no Lexical editor");
	return e;
}

/** Replaces the box with `text` (its `\n`s as line breaks), as if the user typed it. */
function type(text: string): void {
	act(() => {
		editor().update(
			() => {
				const nodes: LexicalNode[] = [];
				text.split("\n").forEach((line, i) => {
					if (i > 0) nodes.push($createLineBreakNode());
					if (line) nodes.push($createTextNode(line));
				});
				const root = $getRoot();
				root.clear();
				root.append($createParagraphNode().append(...nodes));
			},
			{ discrete: true },
		);
	});
}

/** The box's text. */
function box(): string {
	return editor().getEditorState().read(() => $getRoot().getTextContent());
}

/** Enter in the box, then everything it starts. */
async function enter(): Promise<void> {
	act(() => {
		editor().dispatchCommand(KEY_ENTER_COMMAND, null);
	});
	await flush();
}

/** The key of the conversation on screen. */
function shown(tab: Tab): DraftKey {
	const s = useElenchStore.getState();
	return { orgId: tab.page.org, projectId: null, conversationId: s.conversationId };
}

/** The user turns of a stored thread. */
function userTurns(id: string): UIMessage[] {
	return server.threads.get(id)?.messages.filter((m) => m.role === "user") ?? [];
}

/** The transcript's elements showing `text` (the composer's own box excluded). */
function bubbles(text: string): HTMLElement[] {
	return screen.queryAllByText(text).filter((el) => el.closest('[data-testid="elench-composer"]') === null);
}

/** The text of a message. */
function textOf(m: UIMessage | undefined): string {
	return m?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "";
}

/** A stored thread `id` of org scope, holding one answered turn. */
function storedThread(id: string, text = "first"): void {
	server.putThread({
		id,
		projectId: null,
		title: text,
		messages: [
			{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] },
			{ id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: "answer" }] },
		],
	});
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	server = new FakeElenchServer();
	srv.current = server;
	who.viewer = { id: VIEWER };
	nav.pathname = "/acme";
	vi.stubGlobal("fetch", vi.fn(server.fetch));
	useElenchStore.setState({ ...INITIAL, conversationId: crypto.randomUUID() });
	useWidgetGridStore.setState({
		hydrate: vi.fn(async () => undefined),
		reset: vi.fn(),
		pendingCellRequest: null,
		pendingCellTarget: null,
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

// ── A first send (D10, D10b, D12) ───────────────────────────────────────────────────────────

describe("S9 › a first send", () => {
	it("a first send leaves exactly one user turn, with id turnId, in the saved transcript", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		type("  deploy the api  ");
		await enter();
		const k = shown(tab);
		const claim = server.callsOf("claimDraft")[0] as { turnId: string };
		const turns = userTurns(k.conversationId);
		expect(turns).toHaveLength(1);
		expect(turns[0].id).toBe(claim.turnId);
		expect(textOf(turns[0])).toBe("deploy the api");
		// The route was sent that one turn, under its own id, and stored it once.
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0].turnId).toBe(claim.turnId);
		expect(box()).toBe("");
	});

	it("words typed while the thread is created stay in the docked box, and the first turn is only what was sent", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "hold");
		type("first message");
		await enter();
		expect(box()).toBe(""); // the claim emptied the box (I1)
		type("typed meanwhile");
		await flush();
		server.release("startConversation");
		await flush();
		const k = shown(tab);
		expect(userTurns(k.conversationId).map(textOf)).toEqual(["first message"]);
		expect(box()).toBe("typed meanwhile");
		await flush(1_000);
		expect(server.row(k)?.content.text).toBe("typed meanwhile");
	});

	it("landing → first send succeeds → unmount → reload: the box is empty", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab, "modal");
		type("hello");
		await enter();
		const k = shown(tab);
		expect(userTurns(k.conversationId)).toHaveLength(1);
		const again = await reload(tab, unmount, k.conversationId);
		await flush();
		expect(box()).toBe("");
		expect(server.callsOf("startConversation")).toHaveLength(1);
		again.unmount();
	});
});

// ── A later turn (D9, D9b, D9c, D9d) ────────────────────────────────────────────────────────

/** Mounts `tab` on the stored thread `id` (the list resumes it). */
async function mountOnThread(tab: Tab, id: string, view: "modal" | "panel" = "panel"): Promise<() => void> {
	storedThread(id);
	const unmount = await mount(tab, view);
	expect(useElenchStore.getState().conversationId).toBe(id);
	return unmount;
}

describe("S9 › a later turn", () => {
	it("a later turn: claimed, sent with turnId as the message id, consumed at streaming", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		type("scale the workers");
		await enter();
		const claim = server.callsOf("claimDraft")[0] as { turnId: string; kind: string };
		expect(claim.kind).toBe("later");
		expect(server.requests.at(-1)?.turnId).toBe(claim.turnId);
		expect(server.requests.at(-1)?.messages.at(-1)?.id).toBe(claim.turnId);
		expect(server.callsOf("consumeDraft")).toHaveLength(1);
		const row = server.row(shown(tab));
		expect(row?.state).toBe("active");
		expect(row?.content.text).toBe("");
		expect(row?.lastSent?.turnId).toBe(claim.turnId);
		expect(userTurns(T).map(textOf)).toEqual(["first", "scale the workers"]);
		expect(box()).toBe("");
	});

	it("the route answers 402 before streaming: the user bubble is removed and the words are back in the box", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		server.route.push({ kind: "status", status: 402, body: JSON.stringify({ error: "AI limit reached.", reason: "out" }) });
		type("plan the cluster");
		await enter();
		expect(bubbles("plan the cluster")).toHaveLength(0); // no user bubble left in the transcript
		expect(box()).toBe("plan the cluster");
		// D9d (a): the routes' own pre-hold refusal is CERTAIN — "Not sent", never "may already have
		// been sent" — so the release says so, and so does the marker it leaves.
		expect(server.callsOf("releaseClaim")).toMatchObject([{ error: "status-402", uncertain: false }]);
		const row = server.row(shown(tab));
		expect(row?.state).toBe("active");
		expect(row?.content.text).toBe("plan the cluster");
		expect(row?.failedSend).toMatchObject({ uncertain: false });
		expect(userTurns(T).map(textOf)).toEqual(["first"]); // nothing stored
	});

	it("a second send in a new thread leaves New chat's draft saved", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mount(tab);
		type("first in a new thread");
		await enter();
		const thread = shown(tab);
		// New chat: type there, let it save, then go back and send a second turn in the thread.
		act(() => useElenchStore.getState().newChat());
		await flush();
		type("kept for later");
		await flush(1_000);
		const newChatKey = shown(tab);
		expect(server.row(newChatKey)?.content.text).toBe("kept for later");
		act(() => useElenchStore.getState().selectThread(thread.conversationId));
		await flush();
		void T;
		type("second turn");
		await enter();
		expect(userTurns(thread.conversationId).map(textOf)).toEqual(["first in a new thread", "second turn"]);
		expect(server.row(newChatKey)?.content.text).toBe("kept for later");
	});
});

// ── Prompts that are not the box's, and a surface that closes and opens again ────────────────

describe("S9 › suggestions and the surface's own lifetime", () => {
	it("a suggestion card is an external send through the store: no claim, the box untouched, the prompt stored as the first turn", async () => {
		const tab = newTab(ORG_A);
		await mount(tab, "modal");
		type("my own draft");
		act(() => screen.getByRole("button", { name: "Suggestion" }).click());
		await flush();
		const k = shown(tab);
		expect(server.callsOf("startConversation")).toMatchObject([{ origin: "external", text: "Show my clusters" }]);
		expect(server.callsOf("claimDraft")).toHaveLength(0);
		expect(userTurns(k.conversationId).map(textOf)).toEqual(["Show my clusters"]);
		expect(box()).toBe("my own draft");
	});

	it("close and open again: a later turn is sent once (the closed conversation's effects are gone)", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		act(() => useElenchStore.getState().close());
		await flush();
		act(() => useElenchStore.getState().openPanel({ kind: "org" }));
		await flush();
		type("once only");
		await enter();
		expect(server.requests).toHaveLength(1);
		expect(userTurns(T).map(textOf)).toEqual(["first", "once only"]);
	});

	it("an unmounted root listens to nothing: a focus or a Back lists and holds nothing", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		unmount();
		const lists = server.callsOf("listDrafts").length;
		act(() => {
			window.dispatchEvent(new Event("focus"));
			window.dispatchEvent(new PopStateEvent("popstate"));
		});
		await flush();
		expect(server.callsOf("listDrafts")).toHaveLength(lists);
		expect(tab.drafts.store.view.getState().drafts.pageOrg).toBe(ORG_A);
	});
});

// ── A failed first send, and where its words are (D10c, D11, D11r, D17, §5.4) ──────────────────

describe("S9 › a failed first send", () => {
	it("modal↔panel keeps the restored text and its edit; Retry sends the box", async () => {
		const tab = newTab(ORG_A);
		await mount(tab, "modal");
		server.plan("startConversation", "reject");
		type("restart the api");
		await enter();
		const first = server.callsOf("claimDraft")[0] as { turnId: string };
		expect(box()).toBe("restart the api"); // released: the words are back, editable (D11r)
		act(() => useElenchStore.getState().minimize());
		await flush();
		expect(box()).toBe("restart the api"); // the docked composer is a new mount of the same draft
		type("restart the api, gently");
		act(() => useElenchStore.getState().maximize());
		await flush();
		expect(box()).toBe("restart the api, gently");
		await enter(); // Retry is Enter on the box
		const k = shown(tab);
		const turns = userTurns(k.conversationId);
		expect(turns.map(textOf)).toEqual(["restart the api, gently"]);
		// An edited text is a new turn: a fresh id, never the failed send's (it named other words).
		expect(turns[0].id).not.toBe(first.turnId);
	});

	it("a lost created response: the next Enter loads the turn and sends nothing", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "lose");
		type("create the bucket");
		await enter();
		await flush(30_000); // the start's timeout: the release finds the claim consumed (D11c → D17)
		await flush();
		const k = shown(tab);
		expect(userTurns(k.conversationId).map(textOf)).toEqual(["create the bucket"]);
		expect(bubbles("create the bucket")).not.toHaveLength(0); // the stored turn is shown
		expect(box()).toBe("");
		await enter();
		expect(server.requests).toHaveLength(0); // nothing was ever sent to the route
		expect(server.callsOf("startConversation")).toHaveLength(1);
	});

	it("a start slower than 30 s that commits: the release answers not-claimed and the box holds only the later text", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "lose");
		type("first words");
		await enter();
		type("later words");
		await flush(30_000);
		await flush();
		const k = shown(tab);
		expect(server.callsOf("releaseClaim")).toHaveLength(1);
		expect(userTurns(k.conversationId).map(textOf)).toEqual(["first words"]);
		expect(box()).toBe("later words");
		expect(server.requests).toHaveLength(0);
	});

	it("reload after a startConversation that threw: Retry works at once", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("startConversation", "reject");
		type("open a ticket");
		await enter();
		const first = server.callsOf("claimDraft")[0] as { turnId: string };
		const k = shown(tab);
		const again = await reload(tab, unmount, k.conversationId);
		expect(box()).toBe("open a ticket");
		await enter();
		const turns = userTurns(k.conversationId);
		expect(turns.map(textOf)).toEqual(["open a ticket"]);
		expect(turns[0].id).toBe(first.turnId);
		again.unmount();
	});
});

// ── Reload during a send (D26) ──────────────────────────────────────────────────────────────

describe("S9 › reload during a send", () => {
	it("reload during startConversation restores the words in the box, or the thread if it committed", async () => {
		// Not committed: the start never ran.
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("startConversation", "hold");
		type("never started");
		await enter();
		const k = shown(tab);
		const again = await reload(tab, unmount, k.conversationId);
		expect(box()).toBe("never started");
		expect(server.threads.has(k.conversationId)).toBe(false);
		again.unmount();
	});

	it("reload during a start that commits: the box is empty and no second turn is sent", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("startConversation", "lose");
		type("committed meanwhile");
		await enter();
		const k = shown(tab);
		const again = await reload(tab, unmount, k.conversationId);
		await flush();
		expect(box()).toBe("");
		expect(userTurns(k.conversationId).map(textOf)).toEqual(["committed meanwhile"]);
		expect(server.callsOf("startConversation")).toHaveLength(1);
		expect(server.requests).toHaveLength(0);
		again.unmount();
	});

	it("reload between claimDraft and startConversation: the words are back in the box once", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("claimDraft", "lose");
		type("claimed then reloaded");
		await enter();
		const k = shown(tab);
		const again = await reload(tab, unmount, k.conversationId);
		expect(box()).toBe("claimed then reloaded");
		expect(server.row(k)?.state).toBe("active");
		expect(server.row(k)?.content.text).toBe("claimed then reloaded");
		again.unmount();
	});

	it("Enter inside the debounce, reload: the box holds the text once", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("claimDraft", "hold");
		type("enter at once");
		await enter();
		const k = shown(tab);
		const again = await reload(tab, unmount, k.conversationId);
		await flush(1_000);
		expect(box()).toBe("enter at once");
		again.unmount();
	});
});

// ── The empty-cell prompt: an external send with its cell in the event (D10y, D10f) ────────────

/** The empty-cell composer's submit, as the widget grid stages it. */
function askCell(x: number, y: number, text: string): void {
	act(() => useWidgetGridStore.setState({ pendingCellRequest: { x, y, text } }));
}

/** The metadata a stored user turn carries. */
function metaOf(m: UIMessage | undefined): unknown {
	return m?.metadata;
}

describe("S9 › the empty-cell prompt", () => {
	it("the empty-cell prompt into an existing conversation, driven through pendingCellRequest, stores its cell target on its own message", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		askCell(2, 1, "cpu by node");
		await flush();
		const turn = userTurns(T).at(-1);
		expect(textOf(turn)).toBe("cpu by node");
		expect(metaOf(turn)).toMatchObject({ cellTarget: { x: 2, y: 1 } });
		// The request named the cell on the turn's own message, and nothing staged the grid's slot.
		expect(server.requests.at(-1)?.messages.at(-1)?.metadata).toMatchObject({ cellTarget: { x: 2, y: 1 } });
		expect(useWidgetGridStore.getState().pendingCellTarget).toBeNull();
		// It took no claim: the box was never the prompt's.
		expect(server.callsOf("claimDraft")).toHaveLength(0);
	});

	it("after a cell prompt, the next composer turn's stored message has no cellTarget", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		askCell(3, 0, "memory by pod");
		await flush();
		type("and the disk?");
		await enter();
		const turn = userTurns(T).at(-1);
		expect(textOf(turn)).toBe("and the disk?");
		expect(metaOf(turn) ?? {}).not.toHaveProperty("cellTarget");
		expect(server.requests.at(-1)?.cellTarget).toBeNull();
	});

	it("a refused empty-cell prompt into an existing conversation, driven through pendingCellRequest, is in the box with its cell, and Enter lands the widget in that cell", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		server.route.push({
			kind: "refuse",
			status: 409,
			refusal: {
				refusal: "transcript-stale",
				turnId: null,
				committed: false,
				textCommitted: false,
				answered: false,
				revision: 1,
				answerId: null,
			},
		});
		askCell(1, 2, "error rate");
		await flush(1_000);
		expect(box()).toBe("error rate"); // D10f: the prompt is in the box, not lost
		expect(bubbles("error rate")).toHaveLength(0);
		const row = server.row(shown(tab));
		expect(row?.content).toMatchObject({ text: "error rate", cellTarget: { x: 1, y: 2 } });
		await enter(); // the Retry: a claimed composer send of the box, with the content's cell
		const turn = userTurns(T).at(-1);
		expect(textOf(turn)).toBe("error rate");
		expect(metaOf(turn)).toMatchObject({ cellTarget: { x: 1, y: 2 } });
		expect(useWidgetGridStore.getState().pendingCellTarget).toBeNull();
	});
});

describe("S9 › an empty-cell prompt that cannot go yet", () => {
	it("an empty-cell prompt asked while another send runs waits, and goes out with its cell once it can", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		server.route.push({ kind: "hang" });
		type("slow one");
		await enter();
		askCell(4, 2, "latency p99");
		await flush();
		expect(useWidgetGridStore.getState().pendingCellRequest).not.toBeNull(); // kept, not lost (D10z)
		await flush(60_000); // the first send's deadline releases it
		await flush();
		const turn = userTurns(T).at(-1);
		expect(textOf(turn)).toBe("latency p99");
		expect(metaOf(turn)).toMatchObject({ cellTarget: { x: 4, y: 2 } });
		expect(useWidgetGridStore.getState().pendingCellRequest).toBeNull();
	});
});

// ── The interim status line in the bar slot (until slice 11) ───────────────────────────────

/** The bar slot's interim lines, or null when it shows none. */
function statusLine(): string | null {
	const el = screen.queryByTestId("elench-draft-status");
	return el === null ? null : Array.from(el.querySelectorAll("p"), (p) => p.textContent).join(" | ");
}

/** A typed refusal of a later turn the store owns. */
function refuse(code: "transcript-stale" | "thread-busy" | "client-outdated" | "turn-in-progress" | "turn-committed-different-text", committed = false) {
	return {
		kind: "refuse" as const,
		status: 409,
		refusal: {
			refusal: code,
			turnId: null,
			committed,
			textCommitted: committed && code !== "turn-committed-different-text",
			answered: false,
			revision: 1,
			answerId: null,
		},
	};
}

describe("S9 › a refused or failed send is never silent", () => {
	it("a certain refusal (D9d (a)): Not sent, the words back in the box", async () => {
		const tab = newTab(ORG_A);
		await mountOnThread(tab, crypto.randomUUID());
		server.route.push(refuse("thread-busy"));
		type("scale up");
		await enter();
		expect(statusLine()).toBe("Another message in this conversation is being answered | Not sent. Your message is back in the box.");
		expect(box()).toBe("scale up");
	});

	it("D9a's transcript-stale says the newer messages are shown", async () => {
		const tab = newTab(ORG_A);
		await mountOnThread(tab, crypto.randomUUID());
		server.route.push(refuse("transcript-stale"));
		type("scale up");
		await enter();
		expect(statusLine()).toContain("This conversation has newer messages. They are shown now. Press Enter to send.");
		expect(statusLine()).toContain("Not sent. Your message is back in the box.");
	});

	it("a 402 before streaming shows the chat's own budget card, whose Retry is Enter on the box, and says Not sent", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		server.route.push({ kind: "status", status: 402, body: JSON.stringify({ error: "AI limit reached.", reason: "out", resetAt: null, upgradable: false }) });
		type("plan it");
		await enter();
		expect(statusLine()).toBe("Not sent. Your message is back in the box.");
		expect(screen.getByText("AI limit reached.")).toBeTruthy();
		act(() => screen.getByRole("button", { name: /retry/i }).click());
		await flush();
		expect(userTurns(T).map(textOf)).toEqual(["first", "plan it"]);
		expect(statusLine()).toBeNull();
	});

	it("an uncertain failure (D9d (b)) says the message may already have been sent", async () => {
		const tab = newTab(ORG_A);
		await mountOnThread(tab, crypto.randomUUID());
		server.route.push({ kind: "hang" });
		type("drain");
		await enter();
		await flush(60_000);
		await flush();
		expect(statusLine()).toMatch(/^This message may already have been sent/);
	});

	it("turn-committed-different-text (D9d (d)) says an earlier version was sent", async () => {
		const tab = newTab(ORG_A);
		await mountOnThread(tab, crypto.randomUUID());
		server.route.push(refuse("turn-committed-different-text", true));
		type("an edit");
		await enter();
		expect(statusLine()).toContain("An earlier version of this message was already sent. It is shown above. Your edit is still in the box.");
	});

	it("a failed first send says Not sent; while it is being sent it says Sending…", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "hold");
		type("first words");
		await enter();
		expect(statusLine()).toBe("Sending…");
		server.loseHeld("startConversation");
		server.deleteThread(shown(tab).conversationId); // nothing stored; the next release finds the row gone
		await flush(30_000);
		await flush();
		expect(statusLine()).not.toBe("Sending…");
	});

	it("a start that fails says Not sent, and the next Enter clears the line", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "reject");
		type("first words");
		await enter();
		expect(statusLine()).toBe("Not sent. Your message is back in the box.");
		await enter();
		expect(statusLine()).toBeNull();
	});
});

// ── An edited re-send of an uncertain turn (D9d (b) and (d), D31) ─────────────────────────────

describe("S9 › turn-committed-different-text", () => {
	it("an uncertain later turn stored by a late acceptance, edited and re-sent: turn-committed-different-text keeps the edit in the box under a new turn id, and Enter sends it as a new turn", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		server.route.push({ kind: "hang" });
		type("drain the node");
		await enter();
		const first = server.callsOf("claimDraft")[0] as { turnId: string };
		await flush(60_000); // D9d's deadline: stopped, released uncertain, the words are back
		await flush();
		expect(box()).toBe("drain the node");
		expect(server.row(shown(tab))?.failedSend).toMatchObject({ turnId: first.turnId, uncertain: true });
		// The route accepted it late after all: the turn is stored under that id.
		const thread = server.threads.get(T);
		if (!thread) throw new Error("no thread");
		thread.messages.push({ id: first.turnId, role: "user", parts: [{ type: "text", text: "drain the node" }] });
		thread.revision += 1;
		type("drain the node gracefully");
		await flush(1_000); // saved: an UNCERTAIN marker survives the edit, so the re-send names its turn (R10)
		server.route.push({
			kind: "refuse",
			status: 409,
			refusal: {
				refusal: "turn-committed-different-text",
				turnId: first.turnId,
				committed: true,
				textCommitted: false,
				answered: false,
				revision: thread.revision,
				answerId: null,
			},
		});
		await enter();
		const second = server.callsOf("claimDraft")[1] as { turnId: string };
		expect(second.turnId).toBe(first.turnId); // the uncertain marker's id (R10)
		expect(box()).toBe("drain the node gracefully"); // the edit is kept
		const fresh = server.row(shown(tab))?.failedSend?.turnId;
		expect(fresh).toBeTruthy();
		expect(fresh).not.toBe(first.turnId);
		await enter();
		const third = server.callsOf("claimDraft")[2] as { turnId: string };
		expect(third.turnId).toBe(fresh);
		expect(userTurns(T).map(textOf)).toEqual(["first", "drain the node", "drain the node gracefully"]);
		expect(userTurns(T).at(-1)?.id).toBe(fresh);
	});
});

// ── Another tab or device (D13, D17, D18, D21, D22, D35) ─────────────────────────────────────

describe("S9 › another tab or device", () => {
	it("B gets already-stored, the transcript shows A's turns, and B's next send keeps them in the row", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "hold");
		type("one command");
		await enter();
		const k = shown(tab);
		const claim = server.callsOf("claimDraft")[0] as { turnId: string };
		// Tab A (a duplicate holding the same claim) stored this turn and was answered meanwhile.
		server.putThread({
			id: k.conversationId,
			projectId: null,
			title: "one command",
			messages: [
				{ id: claim.turnId, role: "user", parts: [{ type: "text", text: "one command" }] },
				{ id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: "A's answer" }] },
			],
		});
		server.release("startConversation");
		await flush();
		expect(bubbles("A's answer")).not.toHaveLength(0); // loaded, never re-sent (D13)
		expect(server.requests).toHaveLength(0);
		type("one more");
		await enter();
		expect(userTurns(k.conversationId).map(textOf)).toEqual(["one command", "one more"]);
		expect(server.threads.get(k.conversationId)?.messages.map(textOf)).toContain("A's answer");
	});

	it("duplicated tab: Retry in B after A's success loads A's transcript, and a further send from B keeps A's turns", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "reject");
		type("restart it");
		await enter();
		const k = shown(tab);
		const claim = server.callsOf("claimDraft")[0] as { turnId: string };
		expect(box()).toBe("restart it");
		// A, the duplicate, sent the same turn and was answered.
		server.putThread({
			id: k.conversationId,
			projectId: null,
			title: "restart it",
			messages: [
				{ id: claim.turnId, role: "user", parts: [{ type: "text", text: "restart it" }] },
				{ id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: "restarted" }] },
			],
		});
		await enter(); // B's Retry: the claim is a later one now, so the transcript loads first (D9a)
		await flush();
		expect(bubbles("restarted")).not.toHaveLength(0);
		type("and check it");
		await flush(1_000); // saved: a new text drops the (certain) failed-send marker and its id
		await enter();
		expect(server.threads.get(k.conversationId)?.messages.map(textOf)).toEqual([
			"restart it",
			"restarted",
			"and check it",
			"OK",
		]);
	});

	it("device A starts K; on device B the refresh lands and B sends: the row holds A's turns followed by B's", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		const k = shown(tab);
		type("draft on B");
		await flush(1_000);
		// A claims and starts K (B's words are A's here: one draft row), stored with its answer.
		const a = server.transport(() => ORG_A);
		const row = server.row(k);
		const token = crypto.randomUUID();
		const turnId = crypto.randomUUID();
		await a.claimDraft({ ...k, baseRevision: row?.revision ?? 0, content: { text: "from A", mentions: [], artifacts: [], cellTarget: null }, turnId, token, kind: "first", tabId: "tab-a" });
		await a.startConversation({ ...k, origin: "composer", token, turnId, title: "" });
		server.threads.get(k.conversationId)?.messages.push({ id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: "A's reply" }] });
		act(() => window.dispatchEvent(new Event("focus"))); // B's list refresh (D22)
		await flush();
		await flush();
		expect(bubbles("A's reply")).not.toHaveLength(0);
		type("from B");
		await enter();
		expect(userTurns(k.conversationId).map(textOf)).toEqual(["from A", "from B"]);
	});

	it("Discard in B while A chats in the thread leaves the thread and its widgets", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		type("half a thought");
		await flush(1_000);
		const k = shown(tab);
		act(() => tab.drafts.store.dispatch({ type: "ENTRY", key: k, event: { type: "DISCARD" } }));
		await flush();
		expect(server.row(k)?.state).toBe("discarded");
		expect(server.threads.get(T)?.deleted).toBe(false);
		expect(userTurns(T).map(textOf)).toEqual(["first"]);
	});

	it("send into a deleted conversation keeps the words in a new one", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		const k = shown(tab);
		// Elsewhere this conversation was started and then deleted: its id is a tombstone.
		server.putThread({ id: k.conversationId, projectId: null, title: "gone", messages: [], deleted: true });
		type("still needed");
		await enter();
		await flush(1_000);
		const now = shown(tab);
		expect(now.conversationId).not.toBe(k.conversationId); // D18: forked, and the screen followed
		expect(box()).toBe("still needed");
		expect(server.row(now)?.content.text).toBe("still needed");
	});

	it("delete in tab B while tab A's first send is starting: A's words move to a new conversation", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "hold");
		type("about to be deleted");
		await enter();
		const k = shown(tab);
		server.deleteThread(k.conversationId); // B's delete purges the frozen row (§6.3)
		server.release("startConversation");
		await flush(1_000);
		const now = shown(tab);
		expect(now.conversationId).not.toBe(k.conversationId);
		expect(box()).toBe("about to be deleted");
		expect(server.row(now)?.content.text).toBe("about to be deleted");
	});

	it("delete elsewhere then reload: no draft", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		type("soon purged");
		await flush(1_000);
		const k = shown(tab);
		expect(server.row(k)?.content.text).toBe("soon purged");
		server.deleteThread(k.conversationId);
		const again = await reload(tab, unmount, k.conversationId);
		expect(box()).toBe("");
		again.unmount();
	});

	it("a later turn whose consume is delayed 95 s is consumed once, and no other device shows the text", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		for (let i = 0; i < 8; i++) server.plan("consumeDraft", "hold");
		type("rotate the keys");
		await enter();
		await flush(95_000);
		const k = shown(tab);
		// Another device lists the scope: the claim is alive (heartbeats), so the words stay frozen.
		const other = await server.transport(() => ORG_A).listDrafts({ projectId: null });
		if (other.outcome !== "ok") throw new Error("list refused");
		const listed = other.drafts.find((d) => d.row.conversationId === k.conversationId);
		expect(listed?.row.state).toBe("sending");
		while (server.callsOf("consumeDraft").length > 0) {
			try {
				server.release("consumeDraft");
			} catch {
				break;
			}
		}
		await flush();
		const row = server.row(k);
		expect(row?.state).toBe("active");
		expect(row?.content.text).toBe("");
		expect(userTurns(T).map(textOf)).toEqual(["first", "rotate the keys"]);
		expect(box()).toBe("");
	});
});

// ── Orgs, accounts and pages (D23-D25, D29) ─────────────────────────────────────────────────

/** Re-renders the shell for another page (an org switch remounts the `[org]` layout). */
function rerenderPage(tab: Tab, org: string, unmountOld: () => void): () => void {
	unmountOld();
	tab.page.org = org;
	nav.pathname = org === ORG_A ? "/acme" : "/beta";
	useElenchStore.setState({ pageOrgId: org });
	const r = render(
		<ElenchDraftsRoot pageOrgId={org} tab={tab.drafts}>
			<ElenchSurface />
		</ElenchDraftsRoot>,
	);
	return () => r.unmount();
}

describe("S9 › orgs, accounts and pages", () => {
	it("org switch shows B's empty box and keeps A's failed start for A", async () => {
		const tab = newTab(ORG_A);
		const r = render(
			<ElenchDraftsRoot pageOrgId={ORG_A} tab={tab.drafts}>
				<ElenchSurface />
			</ElenchDraftsRoot>,
		);
		useElenchStore.setState({ pageOrgId: ORG_A });
		act(() => useElenchStore.getState().openPanel({ kind: "org" }));
		await flush();
		server.plan("startConversation", "reject");
		type("A's words");
		await enter();
		const a = shown(tab);
		expect(box()).toBe("A's words");
		const unmountB = rerenderPage(tab, ORG_B, () => r.unmount());
		await flush();
		expect(box()).toBe("");
		expect(server.row(a)?.content.text).toBe("A's words");
		expect(server.row(a)?.failedSend).not.toBeNull();
		rerenderPage(tab, ORG_A, unmountB);
		await flush();
		expect(box()).toBe("A's words");
	});

	it("scope change during listDrafts settles for the new scope only", async () => {
		const tab = newTab(ORG_A);
		const K = crypto.randomUUID();
		await server.transport(() => ORG_A).saveDraft({ orgId: ORG_A, projectId: null, conversationId: K, baseRevision: 0, content: { text: "org words", mentions: [], artifacts: [], cellTarget: null }, tabId: "x" });
		server.plan("listDrafts", "hold");
		useElenchStore.setState({ pageOrgId: ORG_A });
		render(
			<ElenchDraftsRoot pageOrgId={ORG_A} tab={tab.drafts}>
				<ElenchSurface />
			</ElenchDraftsRoot>,
		);
		const P = crypto.randomUUID();
		act(() => useElenchStore.getState().openPanel({ kind: "project", projectId: P, environmentId: null }));
		await flush();
		server.release("listDrafts"); // the org scope's late answer
		await flush();
		const drafts = tab.drafts.store.view.getState().drafts;
		expect(drafts.scope).toEqual({ orgId: ORG_A, projectId: P });
		expect(drafts.entries[keyId({ orgId: ORG_A, projectId: null, conversationId: K })]).toBeUndefined();
	});

	it("account B in the same tab never sees A's words", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		type("A's secret");
		act(() => window.dispatchEvent(new Event("pagehide")));
		who.viewer = { id: "00000000-0000-4000-8000-0000000000bb" };
		unmount();
		cleanup();
		await mount(tab);
		expect(box()).toBe("");
		expect(JSON.stringify(Object.values(tab.drafts.store.view.getState().drafts.entries))).not.toContain("A's secret");
		const items = Array.from({ length: tab.storage.length }, (_, i) => tab.storage.getItem(tab.storage.key(i) ?? "") ?? "");
		expect(items.join()).not.toContain("A's secret");
	});

	it("a session that ends without the menu clears the cache", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("saveDraft", "reject");
		type("kubeconfig contents");
		await flush(1_000);
		act(() => window.dispatchEvent(new Event("pagehide")));
		const before = Array.from({ length: tab.storage.length }, (_, i) => tab.storage.getItem(tab.storage.key(i) ?? "") ?? "");
		expect(before.join()).toContain("kubeconfig contents");
		who.viewer = null; // the session expired (no menu sign-out)
		unmount();
		cleanup();
		await mount(tab);
		const after = Array.from({ length: tab.storage.length }, (_, i) => tab.storage.getItem(tab.storage.key(i) ?? "") ?? "");
		expect(after.join()).not.toContain("kubeconfig contents");
	});

	it("with storage that throws, drafts still save to the server", async () => {
		const tab = newTab(ORG_A, memoryStorage(), () => {
			throw new DOMException("denied", "SecurityError");
		});
		await mount(tab);
		type("saved anyway");
		await flush(1_000);
		expect(server.row(shown(tab))?.content.text).toBe("saved anyway");
	});

	it("after a slug rename, the words stay under the org id and save after reload", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.renamed.add(ORG_A);
		type("renamed meanwhile");
		await flush(1_000);
		const k = shown(tab);
		expect(server.row(k)).toBeUndefined(); // scope-changed(address): nothing written
		expect(box()).toBe("renamed meanwhile");
		server.renamed.delete(ORG_A); // the reload is at the new address
		const again = await reload(tab, unmount, k.conversationId);
		await flush(1_000);
		expect(box()).toBe("renamed meanwhile");
		expect(server.row(k)?.content.text).toBe("renamed meanwhile");
		again.unmount();
	});

	it("following the address link re-arms the blocked key and saves it", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.renamed.add(ORG_A);
		type("blocked by the rename");
		await flush(1_000);
		const k = shown(tab);
		expect(server.row(k)).toBeUndefined();
		server.renamed.delete(ORG_A);
		// The link navigates this tab to the org's new address: the same org id, another path.
		rerenderPage(tab, ORG_A, unmount);
		nav.pathname = "/acme-renamed";
		await flush(1_000);
		expect(server.row(k)?.content.text).toBe("blocked by the rename");
	});

	it("Back/Forward between orgs inside the debounce: no write is POSTed from B's page", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		type("typed on A");
		act(() => window.dispatchEvent(new PopStateEvent("popstate"))); // Back: now on B's page
		tab.page.org = ORG_B;
		await flush(1_000);
		expect(server.calls.filter((c) => c.name === "saveDraft" && c.page === ORG_B)).toHaveLength(0);
		// Forward again: A's page names its org, and the words save there.
		tab.page.org = ORG_A;
		rerenderPage(tab, ORG_A, unmount);
		await flush(1_000);
		expect(server.row(shown(tab))?.content.text).toBe("typed on A");
	});

	it("a save handed to Next before router.push is answered other-org and held, then saved on return", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("saveDraft", "hold");
		type("in flight across the switch");
		await flush(1_000);
		const k = shown(tab);
		tab.page.org = ORG_B; // the switch committed while the save waited in Next's queue
		server.release("saveDraft");
		await flush();
		expect(server.row(k)).toBeUndefined();
		expect(tab.drafts.store.view.getState().drafts.entries[keyId(k)]?.save).toBe("held");
		tab.page.org = ORG_A;
		rerenderPage(tab, ORG_A, unmount);
		await flush(1_000);
		expect(server.row(k)?.content.text).toBe("in flight across the switch");
	});

	it("New chat, type, focus inside the debounce: the words stay", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		act(() => useElenchStore.getState().newChat());
		await flush();
		type("not yet saved");
		act(() => window.dispatchEvent(new Event("focus")));
		await flush();
		expect(box()).toBe("not yet saved");
		await flush(1_000);
		expect(server.row(shown(tab))?.content.text).toBe("not yet saved");
	});
});

// ── A long paste (§4.1's bound) ─────────────────────────────────────────────────────────────

describe("S9 › a 50,000-line paste", () => {
	const paste = Array.from({ length: 50_000 }, () => "x").join("\n");

	it("a 50,000-line paste is claimed and sent as the first message", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		type(paste);
		await enter();
		const turns = userTurns(shown(tab).conversationId);
		expect(textOf(turns[0])).toBe(paste);
	});

	it("a 50,000-line paste is sent as a later turn", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		type(paste);
		await enter();
		expect(textOf(userTurns(T).at(-1))).toBe(paste);
	});
});
