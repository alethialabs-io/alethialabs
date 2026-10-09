// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0001 slice 10, the S10 surface tests (§11): which conversation the surface resumes
// (`activeKey[scope]`), the rail's Unsent group, the panel switcher's Unsent entries, the narrow
// toggle's count and the delete confirm's count. These drive the REAL drafts root,
// `ElenchSurface`, `useElenchThreads`, `ElenchConversation`, the REAL modal (its thread rail) and
// panel (its conversation switcher), the real store and the real Lexical composer. Only the server
// is faked (tests/fixtures/elench-drafts-server.ts): the draft actions with real compare-and-set
// semantics, the threads, the chat routes and the heartbeat route. Every clock is a fake timer.
//
// "Reload" is a fresh tab over the same `sessionStorage` and the same server, opened WITHOUT naming
// a conversation: which one it lands on is what this slice decides.

import { act, cleanup, render, screen, within } from "@testing-library/react";
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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerDraft } from "@/lib/elench/draft-outcomes";
import { FakeElenchServer } from "@/tests/fixtures/elench-drafts-server";

const nav = vi.hoisted(() => ({ pathname: "/acme" }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	usePathname: () => nav.pathname,
	useParams: () => ({}),
}));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { id: "00000000-0000-4000-8000-0000000000aa" }, isPending: false }),
}));
const srv = vi.hoisted(() => ({ current: null as FakeElenchServer | null }));
// The real actions are server code; every tab is handed the fake server's transport. The delete
// confirm's count is the one draft action the surface calls directly (not through the store).
vi.mock("@/app/server/actions/elench-drafts", () => ({
	listDrafts: vi.fn(),
	saveDraft: vi.fn(),
	restoreDraft: vi.fn(),
	discardDraft: vi.fn(),
	claimDraft: vi.fn(),
	consumeDraft: vi.fn(),
	releaseClaim: vi.fn(),
	startConversation: vi.fn(),
	countDraftsOfConversation: vi.fn(async ({ id }: { id: string }) => {
		const n = [...(srv.current?.rows.values() ?? [])].filter((r) => r.conversationId === id).length;
		return { outcome: "ok", count: n, orgs: n };
	}),
}));
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
vi.mock("@/components/agent/artifact-panel", () => ({ ArtifactPanel: () => null }));
vi.mock("@/components/agent/widgets/widget-grid", () => ({ WidgetGrid: () => null }));
vi.mock("@/components/agent/elench/elench-scope-chip", () => ({ ElenchScopeChip: () => null }));
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
vi.mock("@/components/agent/elench/suggestion-carousel", () => ({ SuggestionCarousel: () => null }));

import { getThread } from "@/app/server/actions/agent";
import { createDraftsTab, type DraftsTab, ElenchDraftsRoot } from "@/components/agent/elench/elench-drafts-root";
import { ElenchSurface } from "@/components/agent/elench/elench-surface";
import type { DraftKey } from "@/lib/stores/elench-drafts/types";
import { type ElenchCtxRequest, useElenchStore } from "@/lib/stores/use-elench-store";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";

const VIEWER = "00000000-0000-4000-8000-0000000000aa";
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";
const ORG: ElenchCtxRequest = { kind: "org" };

const INITIAL = useElenchStore.getState();

beforeAll(() => {
	Element.prototype.scrollTo ??= () => {};
	Range.prototype.getBoundingClientRect ??= () => new DOMRect();
	Range.prototype.getClientRects ??= () =>
		({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
});

// ── The harness ──────────────────────────────────────────────────────────────────────────────

let server: FakeElenchServer;

/** One browser tab: its drafts over the fake server, posting from the page `page.org`. */
interface Tab {
	drafts: DraftsTab;
	page: { org: string };
	storage: Storage;
}

/** A storage over a plain map, so a "reload" can keep it. */
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
function newTab(org: string, storage: Storage = memoryStorage()): Tab {
	const page = { org };
	const drafts = createDraftsTab({
		viewerId: VIEWER,
		transport: server.transport(() => page.org),
		heartbeat: (body, signal) =>
			server.fetch("/api/elench/drafts/heartbeat", { method: "POST", body: JSON.stringify(body), signal }),
		storage: () => storage,
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

/** Renders the shell's Elench part for `tab`'s page (closed). */
function renderPage(tab: Tab): () => void {
	nav.pathname = tab.page.org === ORG_A ? "/acme" : "/beta";
	useElenchStore.setState({ pageOrgId: tab.page.org });
	const r = render(
		<ElenchDraftsRoot pageOrgId={tab.page.org} tab={tab.drafts}>
			<ElenchSurface />
		</ElenchDraftsRoot>,
	);
	return () => r.unmount();
}

/** Opens the surface in `view` and `ctx`, and lets the list and the resume settle. */
async function openSurface(view: "modal" | "panel" = "modal", ctx: ElenchCtxRequest = ORG): Promise<void> {
	act(() => {
		if (view === "modal") useElenchStore.getState().openModal(ctx);
		else useElenchStore.getState().openPanel(ctx);
	});
	await flush();
}

/** Renders `tab`'s page and opens the surface; returns the unmount. */
async function mount(tab: Tab, view: "modal" | "panel" = "modal"): Promise<() => void> {
	const unmount = renderPage(tab);
	await flush(); // the page's own list settles first, as it does long before a user opens Elench
	await openSurface(view);
	return unmount;
}

/** Closes the surface. */
async function closeSurface(): Promise<void> {
	act(() => useElenchStore.getState().close());
	await flush();
}

/** Reloads: the page's memory is gone, its `sessionStorage` and the server are not. */
async function reload(tab: Tab, unmount: () => void): Promise<{ tab: Tab; unmount: () => void }> {
	act(() => {
		window.dispatchEvent(new Event("pagehide")); // the cache is written synchronously on leave (§7.5)
	});
	unmount();
	tab.drafts.store.dispose();
	cleanup();
	useElenchStore.setState({ ...INITIAL, conversationId: crypto.randomUUID() });
	const next = newTab(tab.page.org, tab.storage);
	return { tab: next, unmount: await mount(next) };
}

/** The live Lexical editor behind the rendered composer. */
function editor(): LexicalEditor {
	const e = getNearestEditorFromDOMNode(screen.getByTestId("elench-composer"));
	if (!e) throw new Error("the composer has no Lexical editor");
	return e;
}

/** Replaces the box with `text`, as if the user typed it. */
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
function shown(tab: Tab, projectId: string | null = null): DraftKey {
	return { orgId: tab.page.org, projectId, conversationId: useElenchStore.getState().conversationId };
}

/** The user turns of a stored thread. */
function userTurns(id: string): UIMessage[] {
	return server.threads.get(id)?.messages.filter((m) => m.role === "user") ?? [];
}

/** The text of a message. */
function textOf(m: UIMessage | undefined): string {
	return m?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "";
}

/** A stored thread `id` of org scope, holding one answered turn, titled `title`. */
function storedThread(id: string, title = "first"): void {
	server.putThread({
		id,
		projectId: null,
		title,
		messages: [
			{ id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: title }] },
			{ id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: "answer" }] },
		],
	});
}

/** Rewrites a stored draft row in place (a state the fake's own actions do not reach). */
function patchRow(k: DraftKey, over: Partial<ServerDraft>): void {
	for (const [id, r] of server.rows)
		if (r.orgId === k.orgId && r.conversationId === k.conversationId) server.rows.set(id, { ...r, ...over });
}

/** The rail's Unsent group, or null when it is not shown. */
function unsentGroup(): HTMLElement | null {
	return screen.queryByRole("group", { name: /Unsent/ });
}

/** The Unsent rows of the rail: each row's label and its note. */
function unsentRows(): { label: string; note: string; el: HTMLElement }[] {
	return screen.queryAllByTestId("thread-rail-unsent-row").map((el) => {
		const [label, note] = [...el.querySelectorAll("span")].map((s) => s.textContent ?? "");
		return { label, note, el };
	});
}

/** Clicks the rail's Unsent row labelled `label`. */
async function openUnsent(label: string): Promise<void> {
	const row = unsentRows().find((r) => r.label === label);
	if (!row) throw new Error(`no Unsent row "${label}" in ${JSON.stringify(unsentRows().map((r) => r.label))}`);
	act(() => row.el.click());
	await flush();
}

/** Clicks the rail's thread row titled `title`. */
async function openThread(title: string): Promise<void> {
	const row = screen.getAllByTestId("thread-rail-row").find((el) => el.textContent?.includes(title));
	if (!row) throw new Error(`no thread row "${title}"`);
	act(() => row.click());
	await flush();
}

/** Clicks the rail's "New chat". */
async function newChat(): Promise<void> {
	act(() => screen.getByRole("button", { name: "New chat" }).click());
	await flush();
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	server = new FakeElenchServer();
	srv.current = server;
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
	vi.clearAllMocks();
});

// ── Which conversation the surface resumes (activeKey[scope], D23, §7.3) ─────────────────────

describe("S10 › resume", () => {
	it("reopen with threads returns to the failed new conversation", async () => {
		const T = crypto.randomUUID();
		storedThread(T, "older thread");
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		expect(useElenchStore.getState().conversationId).toBe(T); // no history here: the newest thread
		await newChat();
		server.plan("startConversation", "reject");
		type("restart the api");
		await enter();
		const failed = shown(tab).conversationId;
		expect(box()).toBe("restart the api");
		// Close and open again: the failed new conversation, not the newest thread.
		await closeSurface();
		await openSurface();
		expect(useElenchStore.getState().conversationId).toBe(failed);
		expect(useElenchStore.getState().threadId).toBeNull();
		expect(box()).toBe("restart the api");
		// …and after a reload, from this tab's mirror of the active conversation.
		const again = await reload(tab, unmount);
		expect(useElenchStore.getState().conversationId).toBe(failed);
		expect(box()).toBe("restart the api");
		await enter(); // Retry is Enter on the box
		expect(userTurns(failed).map(textOf)).toEqual(["restart the api"]);
		again.unmount();
	});

	it("close during startConversation: reopen shows \"No reply arrived\"", async () => {
		storedThread(crypto.randomUUID(), "older thread");
		const tab = newTab(ORG_A);
		await mount(tab);
		await newChat();
		server.plan("startConversation", "hold");
		type("start the cluster");
		await enter();
		const k = shown(tab);
		await closeSurface();
		server.release("startConversation"); // it commits while nothing is mounted (D12)
		await flush();
		expect(server.requests).toHaveLength(0); // nothing pushed the turn to a route
		await openSurface();
		expect(useElenchStore.getState().conversationId).toBe(k.conversationId);
		expect(useElenchStore.getState().threadId).toBe(k.conversationId);
		expect(screen.getByText("No reply arrived")).toBeTruthy();
		expect(screen.queryAllByText("start the cluster").length).toBeGreaterThan(0);
		expect(server.requests).toHaveLength(0);
	});

	it("a conversation deleted in another tab is never resumed: the newest thread is", async () => {
		const A = crypto.randomUUID();
		const B = crypto.randomUUID();
		storedThread(A, "older");
		storedThread(B, "newer");
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		await openThread("older");
		await openThread("newer");
		await closeSurface();
		server.deleteThread(B); // another tab
		await openSurface();
		expect(useElenchStore.getState().conversationId).toBe(A);
		expect(useElenchStore.getState().threadId).toBe(A);
		// …and the same after a reload, from this tab's mirror of the active conversation.
		storedThread(B, "newer");
		act(() => useElenchStore.getState().selectThread(B));
		await flush();
		expect(useElenchStore.getState().conversationId).toBe(B);
		server.deleteThread(B);
		const again = await reload(tab, unmount);
		expect(useElenchStore.getState().conversationId).toBe(A);
		again.unmount();
	});

	it("A→B→A→B keeps each draft; re-selecting keeps it", async () => {
		const A = crypto.randomUUID();
		const B = crypto.randomUUID();
		storedThread(A, "alpha");
		storedThread(B, "beta");
		const tab = newTab(ORG_A);
		await mount(tab);
		await openThread("alpha");
		type("for alpha");
		await openThread("beta");
		type("for beta");
		await openThread("alpha");
		expect(box()).toBe("for alpha");
		await openThread("beta");
		expect(box()).toBe("for beta");
		await openThread("beta"); // re-selecting the conversation on screen
		expect(box()).toBe("for beta");
		await flush(1_000);
		expect(server.row({ orgId: ORG_A, projectId: null, conversationId: A })?.content.text).toBe("for alpha");
		expect(server.row({ orgId: ORG_A, projectId: null, conversationId: B })?.content.text).toBe("for beta");
	});

	it("project and back restores each anchor's active conversation", async () => {
		const P = crypto.randomUUID();
		const T = crypto.randomUUID();
		storedThread(T, "org thread");
		const tab = newTab(ORG_A);
		await mount(tab, "panel");
		act(() => useElenchStore.getState().newChat());
		await flush();
		type("org words");
		const orgKey = shown(tab);
		await openSurface("panel", { kind: "project", projectId: P, environmentId: null });
		type("project words");
		const projectKey = shown(tab, P);
		expect(projectKey.conversationId).not.toBe(orgKey.conversationId);
		await openSurface("panel", ORG);
		expect(useElenchStore.getState().conversationId).toBe(orgKey.conversationId);
		expect(box()).toBe("org words");
		await openSurface("panel", { kind: "project", projectId: P, environmentId: null });
		expect(useElenchStore.getState().conversationId).toBe(projectKey.conversationId);
		expect(box()).toBe("project words");
	});

	it("org switch after load leaves B's active conversation as it was", async () => {
		const T = crypto.randomUUID();
		storedThread(T, "a thread"); // threads are the user's, listed in every org (§1)
		const tab = newTab(ORG_B);
		let unmount = await mount(tab, "panel");
		act(() => useElenchStore.getState().newChat());
		await flush();
		type("B's words");
		await flush(1_000);
		const b = shown(tab);
		// To org A: its page resumes A's own conversation (the newest thread), never B's.
		unmount();
		tab.page.org = ORG_A;
		unmount = renderPage(tab);
		await flush();
		expect(useElenchStore.getState().conversationId).toBe(T);
		// …and back to B, which is where B was left.
		unmount();
		tab.page.org = ORG_B;
		unmount = renderPage(tab);
		await flush();
		expect(useElenchStore.getState().conversationId).toBe(b.conversationId);
		expect(box()).toBe("B's words");
		unmount();
	});
});

// ── The rail's Unsent group (decision 3, §7.4) ───────────────────────────────────────────────

describe("S10 › the Unsent group", () => {
	it("New chat twice keeps both under Unsent", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		type("first idea");
		await flush(1_000);
		await newChat();
		type("second idea");
		await flush(1_000);
		await newChat();
		expect(box()).toBe("");
		await flush(1_000);
		const group = unsentGroup();
		expect(group).not.toBeNull();
		// Most recently written first.
		expect(unsentRows().map((r) => r.label)).toEqual(["second idea", "first idea"]);
		expect(within(group as HTMLElement).getByText("2")).toBeTruthy(); // the group's count
		await openUnsent("first idea");
		expect(box()).toBe("first idea");
	});

	it("sending from an Unsent entry removes it for good", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		type("send me");
		await newChat();
		type("keep me");
		await flush(1_000);
		await openUnsent("send me");
		const k = shown(tab);
		await enter();
		expect(userTurns(k.conversationId).map(textOf)).toEqual(["send me"]);
		expect(unsentRows().map((r) => r.label)).toEqual(["keep me"]);
		const again = await reload(tab, unmount);
		expect(unsentRows().map((r) => r.label)).toEqual(["keep me"]);
		again.unmount();
	});

	it("an unlisted thread's draft is shown under Unsent", async () => {
		const U = crypto.randomUUID();
		// A thread row with no messages yet (unlisted: the rail's thread list never shows it), and a
		// draft of it from another tab.
		server.putThread({ id: U, projectId: null, title: "", messages: [] });
		await server.transport(() => ORG_A).saveDraft({
			orgId: ORG_A,
			projectId: null,
			conversationId: U,
			baseRevision: 0,
			content: { text: "half a question", mentions: [], artifacts: [], cellTarget: null },
			tabId: "elsewhere",
		});
		const tab = newTab(ORG_A);
		await mount(tab);
		expect(screen.queryAllByTestId("thread-rail-row")).toHaveLength(0);
		expect(unsentRows().map((r) => r.label)).toEqual(["half a question"]);
		await openUnsent("half a question");
		expect(useElenchStore.getState().conversationId).toBe(U);
		expect(box()).toBe("half a question");
	});

	it("a reaped thread's draft shows under Unsent as no longer available", async () => {
		const R = crypto.randomUUID();
		storedThread(R, "reaped chat");
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		type("words for a reaped chat");
		await flush(1_000);
		const k = shown(tab);
		// The thread is reaped: the row knows it existed once (`thread_seen`), and nothing is left.
		patchRow(k, { threadSeen: true });
		server.threads.delete(R);
		const again = await reload(tab, unmount);
		const rows = unsentRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].note).toBe("No longer available");
		expect(unsentGroup()?.textContent).not.toMatch(/deleted/i);
		again.unmount();
	});

	it("an Unsent entry whose thread was reaped opens and sends", async () => {
		const R = crypto.randomUUID();
		storedThread(R, "reaped chat");
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		type("send after the reap");
		await flush(1_000);
		patchRow(shown(tab), { threadSeen: true });
		server.threads.delete(R);
		const again = await reload(tab, unmount);
		await newChat(); // somewhere else first, so opening the entry is a real selection
		vi.mocked(getThread).mockClear();
		await openUnsent("send after the reap");
		expect(useElenchStore.getState().conversationId).toBe(R);
		expect(getThread).not.toHaveBeenCalledWith(R); // G21: nothing stored to load
		expect(box()).toBe("send after the reap");
		await enter();
		expect(userTurns(R).map(textOf)).toEqual(["send after the reap"]);
		expect(unsentRows()).toHaveLength(0);
		again.unmount();
	});

	it("a reaped thread's draft and a failed start stay two rows", async () => {
		const R = crypto.randomUUID();
		storedThread(R, "reaped chat");
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		type("reaped words");
		await flush(1_000);
		patchRow(shown(tab), { threadSeen: true });
		server.threads.delete(R);
		await newChat();
		server.plan("startConversation", "reject");
		type("failed start");
		await enter();
		const again = await reload(tab, unmount);
		const notes = Object.fromEntries(unsentRows().map((r) => [r.label, r.note]));
		expect(notes).toEqual({ "reaped words": "No longer available", "failed start": "Not sent" });
		expect(server.rows.size).toBe(2);
		again.unmount();
	});

	it("a failed seed prompt survives a reload in the box and Retry sends it with its cell target", async () => {
		const tab = newTab(ORG_A);
		const unmount = renderPage(tab);
		await flush();
		server.plan("startConversation", "reject");
		act(() => useElenchStore.getState().setSeedPrompt("seeded question"));
		await openSurface();
		const k = shown(tab);
		expect(box()).toBe("seeded question"); // D10f: the refused prompt is the draft's content
		const again = await reload(tab, unmount);
		expect(useElenchStore.getState().conversationId).toBe(k.conversationId);
		expect(box()).toBe("seeded question");
		expect(unsentRows().map((r) => r.note)).toEqual(["Not sent"]);
		const marker = server.row(k)?.failedSend;
		await enter();
		const turns = userTurns(k.conversationId);
		expect(turns.map(textOf)).toEqual(["seeded question"]);
		expect(turns[0].id).toBe(marker?.turnId); // the Retry is the failed send, under its own id
		// …with the cell target its content carries: a seed aims at no cell.
		expect(server.row(k)?.content.cellTarget ?? null).toBeNull();
		expect((turns[0].metadata as { cellTarget?: unknown } | undefined)?.cellTarget ?? null).toBeNull();
		again.unmount();
	});

	// AC14's artifact draft (D3: `OPEN_ARTIFACT_NEW` and the composer's artifact chip) is a gap in
	// ADR 0001 §14: no slice's scope holds `openArtifactInNewChat` or the chip. Ruled out of slice 10
	// (S10 lands at 13/14); the follow-up slice #5848 builds it and turns this into a test.
	it.todo("artifact new chat creates no thread; the chip survives a reload; the first send places it");

	it("the panel's switcher lists the same entries", async () => {
		const tab = newTab(ORG_A);
		await mount(tab, "panel");
		type("panel words");
		await flush(1_000);
		act(() => useElenchStore.getState().newChat());
		await flush();
		const trigger = screen
			.getAllByRole("button", { name: "New conversation" })
			.find((b) => b.getAttribute("data-slot") === "popover-trigger");
		act(() => trigger?.click());
		await flush();
		const group = screen.getByRole("group", { name: "Unsent conversations" });
		expect(within(group).getByText("1")).toBeTruthy();
		const rows = within(group).getAllByTestId("switcher-unsent-row");
		expect(rows.map((r) => r.querySelector("span")?.textContent)).toEqual(["panel words"]);
		act(() => rows[0].click());
		await flush();
		expect(box()).toBe("panel words");
	});

	it("the narrow toggle shows the Unsent count, less the conversation on screen", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		expect(screen.queryByTestId("elench-narrow-rail-unsent")).toBeNull();
		type("one");
		await flush(1_000);
		// The words on screen are in the group, but the user is looking at them: no badge yet.
		expect(unsentRows()).toHaveLength(1);
		expect(screen.queryByTestId("elench-narrow-rail-unsent")).toBeNull();
		await newChat();
		type("two");
		await flush(1_000);
		expect(unsentRows()).toHaveLength(2);
		const toggle = screen.getByRole("button", { name: "Open sidebar, 1 unsent" });
		expect(within(toggle).getByTestId("elench-narrow-rail-unsent").textContent).toBe("1");
	});

	it("a listed thread's draft is noted on its own row, never repeated under Unsent", async () => {
		const T = crypto.randomUUID();
		storedThread(T, "listed chat");
		const tab = newTab(ORG_A);
		await mount(tab);
		type("more for the listed chat");
		await flush(1_000);
		expect(unsentGroup()).toBeNull();
		const row = screen.getAllByTestId("thread-rail-row").find((el) => el.textContent?.includes("listed chat"));
		expect(row?.querySelector('[data-testid="thread-rail-row-note"]')?.textContent).toBe("· Draft");
	});
});

// ── The delete confirm (§6.3) ────────────────────────────────────────────────────────────────

describe("S10 › the delete confirm", () => {
	/** Saves a draft of `id` from a page of `org`. */
	async function draftIn(org: string, id: string, text: string): Promise<void> {
		await server.transport(() => org).saveDraft({
			orgId: org,
			projectId: null,
			conversationId: id,
			baseRevision: 0,
			content: { text, mentions: [], artifacts: [], cellTarget: null },
			tabId: "elsewhere",
		});
	}

	it("the confirm counted two", async () => {
		const T = crypto.randomUUID();
		storedThread(T, "doomed chat");
		await draftIn(ORG_A, T, "draft in A");
		await draftIn(ORG_B, T, "draft in B");
		const tab = newTab(ORG_A);
		await mount(tab);
		act(() => screen.getByRole("button", { name: "Delete chat doomed chat" }).click());
		await flush();
		const dialog = screen.getByRole("alertdialog");
		expect(dialog.textContent).toContain("It also deletes your unsent draft of this conversation in 2 organizations.");
		expect(dialog.textContent).not.toContain("being sent");
		act(() => within(dialog).getByRole("button", { name: "Delete chat" }).click());
		await flush();
		expect([...server.rows.values()].filter((r) => r.conversationId === T)).toHaveLength(0);
	});

	it("the confirm names a message being sent when the stored row is sending", async () => {
		// The row as this tab last listed it is `sending`, with no claim bar of its own open (the
		// listed-row arm of R8, apart from D30's `claimed` conflict).
		const T = crypto.randomUUID();
		storedThread(T, "row sending");
		await draftIn(ORG_A, T, "queued words");
		const tab = newTab(ORG_A);
		await mount(tab);
		act(() =>
			tab.drafts.store.view.setState((v) => {
				const entries = { ...v.drafts.entries };
				for (const [id, e] of Object.entries(entries))
					if (e.key.conversationId === T && e.server !== null)
						entries[id] = { ...e, conflict: null, server: { ...e.server, state: "sending" } };
				return { drafts: { ...v.drafts, entries } };
			}),
		);
		act(() => screen.getByRole("button", { name: "Delete chat row sending" }).click());
		await flush();
		expect(screen.getByRole("alertdialog").textContent).toContain(
			"A message in this conversation is being sent right now.",
		);
	});

	it("the confirm names a message being sent", async () => {
		const T = crypto.randomUUID();
		storedThread(T, "busy chat");
		// Another device holds a claim on this conversation's draft (§3.4).
		await draftIn(ORG_A, T, "on its way");
		patchRow({ orgId: ORG_A, projectId: null, conversationId: T }, {
			state: "sending",
			claim: { token: crypto.randomUUID(), turnId: crypto.randomUUID(), kind: "later", claimedAt: new Date().toISOString() },
		});
		const tab = newTab(ORG_A);
		await mount(tab);
		act(() => screen.getByRole("button", { name: "Delete chat busy chat" }).click());
		await flush();
		const dialog = screen.getByRole("alertdialog");
		expect(dialog.textContent).toContain("It also deletes your unsent draft of this conversation in 1 organization.");
		expect(dialog.textContent).toContain("A message in this conversation is being sent right now.");
	});
});
