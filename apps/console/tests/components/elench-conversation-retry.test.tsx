// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A user's message is never lost silently (maintainer ruling, #5423 review), and Retry is Enter on
// the box. Since ADR 0001 slice 9 a failed first send is not a card with a Retry of its own: the
// words come back into the box (D11r for the composer, D10f for a prompt that was never the box's),
// still editable, in the panel and in the modal, and Enter sends what the box shows then, under the
// failed send's own turn id. These drive the real drafts root, surface, conversation, store and
// Lexical composer over the in-memory server (tests/fixtures/elench-drafts-server.ts).

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
// The surface loads its conversation with a dynamic import (#5849); importing the module here puts it
// in the module cache first, so the lazy component resolves within `flush()`'s microtasks instead
// of waiting on a cold transform of the whole chat graph.
import "@/components/agent/elench/elench-conversation";
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
	});
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe.each(["panel", "modal"] as const)("ElenchConversation (%s) — Retry after a failed first send", (view) => {
	it("shows no error card, and the words are back in the box, editable", async () => {
		const tab = newTab(ORG_A);
		await mount(tab, view);
		server.plan("startConversation", "reject");
		type("first try");
		await enter();
		expect(box()).toBe("first try");
		expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
		expect(editor().isEditable()).toBe(true);
	});

	it("sends the EDITED text on Enter, as a new turn under a fresh id (the failed text is not what is sent)", async () => {
		const tab = newTab(ORG_A);
		await mount(tab, view);
		server.plan("startConversation", "reject");
		type("first try");
		await enter();
		const failed = server.callsOf("claimDraft")[0] as { turnId: string };
		type("first try, edited");
		await enter();
		const turns = userTurns(shown(tab).conversationId);
		expect(turns.map(textOf)).toEqual(["first try, edited"]);
		expect(turns[0].id).not.toBe(failed.turnId);
	});

	it("re-sends the UNEDITED text under the failed send's own turn id", async () => {
		const tab = newTab(ORG_A);
		await mount(tab, view);
		server.plan("startConversation", "reject");
		type("first try");
		await enter();
		const failed = server.callsOf("claimDraft")[0] as { turnId: string };
		await enter();
		expect(userTurns(shown(tab).conversationId)[0].id).toBe(failed.turnId);
	});

	it("keeps the edited text when the second try fails too", async () => {
		const tab = newTab(ORG_A);
		await mount(tab, view);
		server.plan("startConversation", "reject");
		server.plan("startConversation", "reject");
		type("first try");
		await enter();
		type("second try");
		await enter();
		expect(box()).toBe("second try");
		expect(server.threads.size).toBe(0);
	});

	it("an emptied box sends nothing", async () => {
		const tab = newTab(ORG_A);
		await mount(tab, view);
		server.plan("startConversation", "reject");
		type("first try");
		await enter();
		type("");
		await enter();
		expect(server.callsOf("claimDraft")).toHaveLength(1);
		expect(server.threads.size).toBe(0);
	});

	it("a failed seed prompt (it never lived in the box) lands in the box, and Enter sends it", async () => {
		const tab = newTab(ORG_A);
		server.plan("startConversation", "reject");
		useElenchStore.setState({ seedPrompt: "create a staging cluster" });
		await mount(tab, view);
		await flush(1_000);
		expect(box()).toBe("create a staging cluster");
		await enter();
		expect(userTurns(shown(tab).conversationId).map(textOf)).toEqual(["create a staging cluster"]);
	});
});
