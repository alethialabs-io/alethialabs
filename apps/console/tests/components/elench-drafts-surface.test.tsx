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
	return () => {
		r.unmount();
		tab.drafts.store.dispose();
	};
}

/** Reloads: the page's memory is gone, its `sessionStorage` and the server are not. */
async function reload(tab: Tab, unmount: () => void, open?: string): Promise<{ tab: Tab; unmount: () => void }> {
	act(() => {
		window.dispatchEvent(new Event("pagehide")); // the cache is written synchronously on leave (§7.5)
	});
	unmount();
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
		expect(server.callsOf("releaseClaim")).toHaveLength(1);
		const row = server.row(shown(tab));
		expect(row?.state).toBe("active");
		expect(row?.content.text).toBe("plan the cluster");
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
		expect(turns[0].id).toBe(first.turnId); // the failed send's turn id, never re-minted
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
