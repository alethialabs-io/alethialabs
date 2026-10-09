// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0001 slice 11, the S11 tests (§11): every assertion on a draft's footer status, bar or notice.
// Like S9 and S10 they drive the REAL drafts root, `ElenchSurface`, `useElenchThreads`,
// `ElenchConversation`, the real store and the real Lexical composer with `useAgentChat`'s real
// `useChat`; only the server is faked, with real compare-and-set semantics
// (tests/fixtures/elench-drafts-server.ts). Every clock is a fake timer.
//
// "Reload" is a fresh tab over the same `sessionStorage` and the same server; "another device" is the
// same server reached through its own transport, with its own page org and no `sessionStorage`.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import type { DraftsTransport } from "@/lib/stores/elench-drafts/store";
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
const srv = vi.hoisted(() => ({ current: null as FakeElenchServer | null, getThreadFails: 0 }));
vi.mock("@/app/server/actions/agent", () => ({
	listThreads: vi.fn(async (projectId?: string) => srv.current?.listThreads(projectId) ?? []),
	getThread: vi.fn(async (id: string) => {
		if (srv.getThreadFails > 0) {
			srv.getThreadFails -= 1;
			throw new Error("getThread failed");
		}
		return srv.current?.getThread(id) ?? null;
	}),
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
const orgs = vi.hoisted(() => [
	{ id: "00000000-0000-4000-8000-00000000000a", name: "Acme", slug: "acme" },
	{ id: "00000000-0000-4000-8000-00000000000b", name: "Beta", slug: "beta" },
]);
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: <T,>(select: (s: { organizations: typeof orgs }) => T): T => select({ organizations: orgs }),
}));
vi.mock("@/components/agent/elench/elench-controls", () => ({
	ElenchAskMode: () => null,
	ElenchDeepReasoning: () => null,
	ElenchModelButton: () => null,
}));
vi.mock("@/components/agent/elench/mention-typeahead", () => ({
	MentionTypeaheadPlugin: () => null,
}));
vi.mock("@/components/agent/elench/suggestion-carousel", () => ({ SuggestionCarousel: () => null }));
vi.mock("@/components/agent/elench/elench-modal", () => ({
	ElenchModal: ({ children }: { children: ReactNode }) => <div data-testid="modal">{children}</div>,
}));
vi.mock("@/components/agent/elench/elench-panel", () => ({
	ElenchPanel: ({ children }: { children: ReactNode }) => <div data-testid="panel">{children}</div>,
}));
const toasts = vi.hoisted(() => ({ shown: [] as { title: string; description: string }[] }));
vi.mock("sonner", () => ({
	toast: Object.assign(
		(title: string, opts?: { description?: string }) => {
			toasts.shown.push({ title, description: opts?.description ?? "" });
		},
		{ error: () => undefined, success: () => undefined },
	),
}));
// The account menu's own neighbours, which the sign-out confirm does not depend on.
const auth = vi.hoisted(() => ({ signOut: vi.fn(async () => undefined) }));
vi.mock("@/lib/auth/client", () => ({ authClient: auth }));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
vi.mock("@/components/theme-menu", () => ({ InlineThemeSwitcher: () => null }));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({ useUpgradeSheet: () => ({ openUpgrade: vi.fn() }) }));
vi.mock("@repo/privacy/consent-provider", () => ({ useConsent: () => ({ openPreferences: vi.fn() }) }));
vi.mock("@/components/shell/account-settings-dialog", () => ({ AccountSettingsDialog: () => null }));
vi.mock("@/components/shell/feedback-dialog", () => ({ FeedbackDialog: () => null }));
vi.mock("@/components/shell/notifications-popover", () => ({ NotificationsPopover: () => null }));

import { COPY, excerpt, noticeLines, notSentReason } from "@/components/agent/elench/draft-status/copy";
import { createDraftsTab, type DraftsTab, ElenchDraftsRoot } from "@/components/agent/elench/elench-drafts-root";
import { ElenchSurface } from "@/components/agent/elench/elench-surface";
import { SidebarProfile } from "@/components/shell/sidebar-profile";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/ai/message-limits";
import { keyId } from "@/lib/stores/elench-drafts/reducer-drafting";
import type { DraftKey } from "@/lib/stores/elench-drafts/types";
import { useElenchStore } from "@/lib/stores/use-elench-store";
import { useWidgetGridStore } from "@/lib/stores/use-widget-grid-store";
import type { TurnRefusalCode } from "@/lib/agent/turn-claims";

const VIEWER = "00000000-0000-4000-8000-0000000000aa";
const ORG_A = "00000000-0000-4000-8000-00000000000a";
const ORG_B = "00000000-0000-4000-8000-00000000000b";

const INITIAL = useElenchStore.getState();

beforeAll(() => {
	Element.prototype.scrollTo ??= () => {};
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

/** A new tab (or a reload of one: pass its storage) of `org`; `over` replaces some of its actions. */
function newTab(org: string, storage: Storage = memoryStorage(), over: Partial<DraftsTransport> = {}): Tab {
	const page = { org };
	const drafts = createDraftsTab({
		viewerId: VIEWER,
		transport: { ...server.transport(() => page.org), ...over },
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

/** Renders the shell's Elench part for `tab`, opened as the panel; resolves once the list settled. */
async function mount(tab: Tab): Promise<() => void> {
	useElenchStore.setState({ pageOrgId: tab.page.org });
	const r = render(
		<ElenchDraftsRoot pageOrgId={tab.page.org} tab={tab.drafts}>
			<ElenchSurface />
		</ElenchDraftsRoot>,
	);
	act(() => useElenchStore.getState().openPanel({ kind: "org" }));
	await flush();
	return () => r.unmount();
}

/** Re-renders the shell for another page (an org switch remounts the `[org]` layout). */
function rerenderPage(tab: Tab, org: string, unmountOld: () => void, pathname?: string): () => void {
	unmountOld();
	tab.page.org = org;
	nav.pathname = pathname ?? (org === ORG_A ? "/acme" : "/beta");
	useElenchStore.setState({ pageOrgId: org });
	const r = render(
		<ElenchDraftsRoot pageOrgId={org} tab={tab.drafts}>
			<ElenchSurface />
		</ElenchDraftsRoot>,
	);
	return () => r.unmount();
}

/** Reloads: the page's memory is gone, its `sessionStorage` and the server are not. */
async function reload(tab: Tab, unmount: () => void, open?: string): Promise<{ tab: Tab; unmount: () => void }> {
	act(() => {
		window.dispatchEvent(new Event("pagehide"));
	});
	unmount();
	tab.drafts.store.dispose();
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
function shown(tab: Tab): DraftKey {
	const s = useElenchStore.getState();
	return { orgId: tab.page.org, projectId: null, conversationId: s.conversationId };
}

/** The user turns of a stored thread. */
function userTurns(id: string): UIMessage[] {
	return server.threads.get(id)?.messages.filter((m) => m.role === "user") ?? [];
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

/** Mounts `tab` on the stored thread `id`. */
async function mountOnThread(tab: Tab, id: string): Promise<() => void> {
	storedThread(id);
	const unmount = await mount(tab);
	expect(useElenchStore.getState().conversationId).toBe(id);
	return unmount;
}

/** The bar and lines above the box, joined with " | ", or null when it shows nothing. */
function statusLine(): string | null {
	const el = screen.queryByTestId("elench-draft-status");
	return el === null ? null : Array.from(el.querySelectorAll("p"), (p) => p.textContent).join(" | ");
}

/** The footer's status under the box, or null when it shows nothing. */
function footer(): string | null {
	return screen.queryByTestId("elench-draft-footer")?.textContent ?? null;
}

/** The decision bar (an alert with its actions), or null. */
function decisionBar(): HTMLElement | null {
	return screen.queryByTestId("elench-draft-bar");
}

/** Clicks the bar's action named `name`. */
async function clickBar(name: string): Promise<void> {
	const bar = decisionBar();
	if (bar === null) throw new Error("no decision bar");
	const button = Array.from(bar.querySelectorAll("button")).find((b) => b.textContent === name);
	if (button === undefined) throw new Error(`no ${name} in the bar`);
	act(() => button.click());
	await flush();
}

/** Another device's draft actions: the same server, its own page org and tab id. */
function device(org = ORG_A): DraftsTransport {
	return server.transport(() => org);
}

/** A typed refusal of a later turn. */
function refusal(code: TurnRefusalCode, committed = false) {
	return {
		kind: "refuse" as const,
		status: code === "thread-deleted" ? 410 : code.endsWith("not-found") ? 404 : code === "org-forbidden" ? 403 : 409,
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

/** Dispatches `beforeunload` and answers whether the page asked to confirm the close. */
function asksToLeave(): boolean {
	const e = new Event("beforeunload", { cancelable: true });
	act(() => {
		window.dispatchEvent(e);
	});
	return e.defaultPrevented;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	server = new FakeElenchServer();
	srv.current = server;
	srv.getThreadFails = 0;
	toasts.shown = [];
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

// ── The S11 tests named in ADR 0001 §11 ───────────────────────────────────────────────────────

describe("S11 › §11's notices, bars and footer", () => {
	it("reload lands on the active conversation with its draft and its Not-sent card", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("startConversation", "reject");
		type("restart the api");
		await enter();
		expect(statusLine()).toBe(COPY.unreachable);
		const k = shown(tab);
		const again = await reload(tab, unmount, k.conversationId);
		await flush();
		expect(shown(again.tab).conversationId).toBe(k.conversationId);
		expect(box()).toBe("restart the api");
		// No notice survives a reload; the card is said from the row's failed-send marker (§5.4).
		expect(statusLine()).toBe(COPY.unreachable);
		again.unmount();
	});

	it("a cache item older than the server row becomes a conflict, not a resurrection", async () => {
		let offline = false;
		const tab = newTab(ORG_A, memoryStorage(), {
			saveDraft: (input) =>
				offline ? Promise.reject(new TypeError("Failed to fetch")) : server.transport(() => ORG_A).saveDraft(input),
		});
		const unmount = await mount(tab);
		type("deploy");
		await flush(1_000);
		const k = shown(tab);
		expect(server.row(k)?.content.text).toBe("deploy");
		// "deploy now" never reaches the server: the save fails, and the tab keeps it in its cache.
		offline = true;
		type("deploy now");
		await flush(1_000);
		expect(footer()).toBe(COPY.retrying);
		// Meanwhile another device saves over the base the cache item names.
		const row = server.row(k);
		await device().saveDraft({ ...k, baseRevision: row?.revision ?? 0, content: { text: "deploy later", mentions: [], artifacts: [], cellTarget: null }, tabId: "other" });
		const again = await reload(tab, unmount, k.conversationId);
		await flush();
		expect(box()).toBe("deploy now"); // mine, kept (I5) …
		expect(server.row(k)?.content.text).toBe("deploy later"); // … and never written over theirs
		expect(decisionBar()?.getAttribute("role")).toBe("alert");
		expect(statusLine()).toContain(COPY.edited);
		expect(decisionBar()?.textContent).toContain("“deploy now”");
		expect(decisionBar()?.textContent).toContain("“deploy later”");
		await clickBar("Use theirs");
		expect(box()).toBe("deploy later");
		expect(decisionBar()).toBeNull();
		expect(document.activeElement).toBe(screen.getByTestId("elench-composer"));
		again.unmount();
	});

	it("an emptied box sends nothing and says so", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "reject");
		type("scale down");
		await enter();
		type("");
		await enter();
		expect(server.callsOf("claimDraft")).toHaveLength(1);
		expect(statusLine()).toBe(COPY.emptyBox);
	});

	it("the card names where the words are", async () => {
		// Kept in this tab, while the save retries (D27) …
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("saveDraft", "reject");
		type("drain node-3");
		await flush(1_000);
		expect(footer()).toBe(COPY.retrying);
		// … saved to the account once it lands …
		await flush(2_000);
		expect(server.row(shown(tab))?.content.text).toBe("drain node-3");
		expect(footer()).toBe(COPY.saved);
		await flush(2_000);
		expect(footer()).toBeNull();
		unmount();
		cleanup();
		// … in this tab only, when the save is refused for good (D28) …
		const refused = newTab(ORG_A, memoryStorage(), {
			saveDraft: async () => ({ outcome: "forbidden", reason: "membership" }),
		});
		await mount(refused);
		type("cordon node-4");
		await flush(1_000);
		expect(footer()).toBe(COPY.membership);
		cleanup();
		// … and nowhere when this tab cannot keep it either.
		const full = newTab(ORG_A, {
			...memoryStorage(),
			getItem: () => null,
			setItem: () => {
				throw new DOMException("full", "QuotaExceededError");
			},
		});
		await mount(full);
		server.plan("saveDraft", "reject");
		type("uncordon node-4");
		await flush(1_000);
		expect(footer()).toBe(COPY.retryingUncached);
		expect(asksToLeave()).toBe(true);
	});

	it("the too-long card clears once the box is under the limit", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		type("x".repeat(MAX_USER_MESSAGE_CHARS + 1));
		await flush();
		expect(screen.queryByTestId("elench-composer-too-long")).not.toBeNull();
		type("x".repeat(MAX_USER_MESSAGE_CHARS));
		await flush();
		expect(screen.queryByTestId("elench-composer-too-long")).toBeNull();
	});

	it("committed-but-lost start, type more, reload: the box holds only the later text and the notice says the first message was sent", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("startConversation", "lose");
		type("first words");
		await enter();
		type("later words");
		const k = shown(tab);
		const again = await reload(tab, unmount, k.conversationId);
		await flush();
		expect(box()).toBe("later words");
		expect(statusLine()).toBe(COPY.firstSentMoreInBox);
		expect(userTurns(k.conversationId).map(textOf)).toEqual(["first words"]);
		expect(server.requests).toHaveLength(0);
		again.unmount();
	});

	it("after a rename the footer offers the new address, and following it in this tab saves the words", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.renamed.add(ORG_A);
		nav.pathname = "/acme/projects";
		type("renamed meanwhile");
		await flush(1_000);
		const k = shown(tab);
		expect(server.row(k)).toBeUndefined();
		expect(footer()).toContain(COPY.address);
		const link = screen.getByRole("link", { name: "Open the new address" });
		expect(link.getAttribute("href")).toBe("/renamed/projects");
		// Following it is this tab navigating to the org's new address: the same org id, another path.
		server.renamed.delete(ORG_A);
		rerenderPage(tab, ORG_A, unmount, "/renamed/projects");
		await flush(1_000);
		expect(server.row(k)?.content.text).toBe("renamed meanwhile");
	});

	it("device B saves, device A presses Enter inside the debounce: nothing is sent and the conflict bar shows both texts", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		type("restart api");
		await flush(1_000);
		const k = shown(tab);
		const base = server.row(k)?.revision ?? 0;
		await device().saveDraft({ ...k, baseRevision: base, content: { text: "restart api and worker", mentions: [], artifacts: [], cellTarget: null }, tabId: "device-b" });
		type("restart api now");
		await enter(); // inside the debounce: the claim is the flush, at the old base
		expect(server.callsOf("startConversation")).toHaveLength(0);
		expect(server.requests).toHaveLength(0);
		expect(box()).toBe("restart api now");
		expect(statusLine()).toContain(COPY.edited);
		expect(statusLine()).toContain(COPY.notSent);
		expect(decisionBar()?.textContent).toContain("“restart api now”");
		expect(decisionBar()?.textContent).toContain("“restart api and worker”");
		await clickBar("Keep mine");
		await flush(1_000);
		expect(server.row(k)?.content.text).toBe("restart api now");
		expect(document.activeElement).toBe(screen.getByTestId("elench-composer"));
	});

	it("a lost created response, then the 30 s timeout: the release answers not-claimed, the card says the message was sent, and no second send happens", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "lose");
		type("create the bucket");
		await enter();
		expect(statusLine()).toBe(COPY.sending);
		await flush(30_000);
		await flush();
		expect(server.callsOf("releaseClaim")).toHaveLength(1);
		expect(statusLine()).toBe(COPY.firstSent);
		expect(server.callsOf("startConversation")).toHaveLength(1);
		expect(server.requests).toHaveLength(0);
	});

	it("type on A, switch to B while a save is in flight, switch back: the words save under A and the footer says Saved", async () => {
		const tab = newTab(ORG_A);
		const unmount = await mount(tab);
		server.plan("saveDraft", "hold");
		type("in flight across the switch");
		await flush(1_000);
		expect(footer()).toBe(COPY.saving);
		const k = shown(tab);
		const onB = rerenderPage(tab, ORG_B, unmount);
		server.release("saveDraft");
		await flush();
		expect(tab.drafts.store.view.getState().drafts.entries[keyId(k)]?.save).toBe("held");
		expect(toasts.shown.at(-1)?.description).toBe(
			"Not saved yet: this tab shows another organization. It saves when you go back to that organization in this tab.",
		);
		rerenderPage(tab, ORG_A, onB);
		await flush(1_000);
		expect(server.row(k)?.content.text).toBe("in flight across the switch");
		expect(footer()).toBe(COPY.saved);
		await flush(2_000);
		expect(footer()).toBeNull();
	});

	it("two devices, same draft, Enter on both: one turn is sent, and the other device shows the sent notice", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		type("rotate the keys");
		await flush(1_000);
		const k = shown(tab);
		const row = server.row(k);
		// Device B presses Enter first: its claim freezes the row.
		const token = crypto.randomUUID();
		const turnId = crypto.randomUUID();
		await device().claimDraft({ ...k, baseRevision: row?.revision ?? 0, content: { text: "rotate the keys", mentions: [], artifacts: [], cellTarget: null }, turnId, token, kind: "later", tabId: "device-b" });
		await enter(); // device A: refused, nothing sent
		expect(server.requests).toHaveLength(0);
		expect(statusLine()).toContain(COPY.claimed);
		expect(screen.getByTestId("elench-composer").getAttribute("aria-readonly")).toBe("true");
		// B's route stores the turn and B consumes its claim.
		server.threads.get(T)?.messages.push({ id: turnId, role: "user", parts: [{ type: "text", text: "rotate the keys" }] });
		await device().consumeDraft({ ...k, token });
		await flush(10_000); // A polls every 10 s while another device sends
		await flush();
		expect(userTurns(T).map(textOf)).toEqual(["first", "rotate the keys"]);
		expect(statusLine()).toBe(COPY.sentElsewhere);
		expect(box()).toBe("");
	});

	it("an edit over a message another device sent: the conflict bar names that message from the transcript", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		type("drain node one");
		await flush(1_000);
		const k = shown(tab);
		// Device B sends this draft: it claims it, its route stores the turn, and it consumes the claim.
		const token = crypto.randomUUID();
		const turnId = crypto.randomUUID();
		const sentText = "drain node one, and when it is empty cordon it until the kernel patch has rolled out";
		await device().claimDraft({ ...k, baseRevision: server.row(k)?.revision ?? 0, content: { text: sentText, mentions: [], artifacts: [], cellTarget: null }, turnId, token, kind: "later", tabId: "device-b" });
		server.threads.get(T)?.messages.push({ id: turnId, role: "user", parts: [{ type: "text", text: sentText }] });
		await device().consumeDraft({ ...k, token });
		type("drain node one, then cordon"); // A keeps typing on its stale base
		await flush(1_000);
		await flush();
		expect(box()).toBe("drain node one, then cordon");
		expect(statusLine()).toContain(`This message was sent from another tab or device: “${sentText.slice(0, 60).trimEnd()}…”`);
		expect(decisionBar()?.textContent).toContain("“drain node one, then cordon”");
	});

	it("device A's live claim: device B's box is read-only with the being-sent bar", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		type("roll back the release");
		await flush(1_000);
		const k = shown(tab);
		const row = server.row(k);
		await device().claimDraft({ ...k, baseRevision: row?.revision ?? 0, content: { text: "roll back the release", mentions: [], artifacts: [], cellTarget: null }, turnId: crypto.randomUUID(), token: crypto.randomUUID(), kind: "first", tabId: "device-a" });
		act(() => window.dispatchEvent(new Event("focus")));
		await flush();
		expect(statusLine()).toBe(COPY.claimed);
		expect(decisionBar()).toBeNull(); // nothing to decide: it is a state, said politely
		expect(screen.getByTestId("elench-composer").getAttribute("aria-readonly")).toBe("true");
	});

	it("a tab closed after its later turn's route accepted: the next open shows may-already-have-been-sent, and Enter after an edit still sends the same turn id", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		const unmount = await mountOnThread(tab, T);
		server.route.push({ kind: "hang" });
		type("drain the node");
		await enter();
		const first = server.callsOf("claimDraft")[0] as { turnId: string };
		// The tab closes: its memory and its `sessionStorage` go, and nothing releases the claim.
		unmount();
		tab.drafts.store.dispose();
		cleanup();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(121_000); // the lease settles a silent claim (S5)
		});
		useElenchStore.setState({ ...INITIAL, conversationId: T });
		const next = newTab(ORG_A);
		await mount(next);
		await flush();
		expect(box()).toBe("drain the node");
		expect(statusLine()).toMatch(/^This message may already have been sent/);
		expect(decisionBar()?.getAttribute("role")).toBe("alert");
		type("drain the node, gently");
		await flush(1_000);
		await enter();
		const again = server.callsOf("claimDraft").at(-1) as { turnId: string };
		expect(again.turnId).toBe(first.turnId);
	});

	it("a 5xx before streaming releases uncertain and shows the check-the-conversation card", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		server.route.push({ kind: "status", status: 502, body: "Bad gateway" });
		type("restart the ingress");
		await enter();
		await flush();
		expect(server.callsOf("releaseClaim")).toMatchObject([{ error: "status-502", uncertain: true }]);
		expect(statusLine()).toBe(COPY.uncertain);
		expect(statusLine()).not.toContain(COPY.notSent);
		const bar = decisionBar();
		expect(bar?.getAttribute("role")).toBe("alert");
		expect(Array.from(bar?.querySelectorAll("button") ?? [], (b) => b.textContent)).toEqual(["Show conversation", "Dismiss"]);
		await clickBar("Dismiss");
		expect(decisionBar()).toBeNull();
		expect(document.activeElement).toBe(screen.getByTestId("elench-composer"));
		expect(box()).toBe("restart the ingress");
	});

	it("getThread rejecting on load renders the draft with Retry", async () => {
		const T = crypto.randomUUID();
		storedThread(T);
		const tab = newTab(ORG_A);
		srv.getThreadFails = 1;
		await mount(tab);
		await flush();
		const retry = screen.getByRole("button", { name: "Retry" });
		expect(screen.getByTestId("elench-composer")).toBeTruthy();
		expect(statusLine()).toContain("The conversation could not be loaded.");
		act(() => retry.click());
		await flush();
		expect(useElenchStore.getState().conversationId).toBe(T);
		expect(statusLine()).toBeNull();
	});
});

// ── Every refusal family keeps a visible, specific message ──────────────────────────────────

describe("S11 › every refused send says why", () => {
	const typed: [TurnRefusalCode, string][] = [
		["thread-busy", COPY.threadBusy],
		["transcript-stale", COPY.transcriptStale],
		["client-outdated", COPY.reloadToContinue],
		["thread-not-found", "This conversation no longer exists."],
		["project-not-found", "This project no longer exists."],
		["org-forbidden", "You are not an active member of this organization."],
	];
	for (const [code, said] of typed)
		it(`a later turn refused ${code} says so, and Not sent`, async () => {
			const tab = newTab(ORG_A);
			await mountOnThread(tab, crypto.randomUUID());
			server.route.push(refusal(code));
			type("scale up");
			await enter();
			expect(statusLine()).toContain(said);
			expect(statusLine()).toContain(COPY.notSent);
			expect(box()).toBe("scale up");
		});

	it("a later turn refused thread-deleted keeps the words in a new conversation and says so", async () => {
		const T = crypto.randomUUID();
		const tab = newTab(ORG_A);
		await mountOnThread(tab, T);
		server.route.push(refusal("thread-deleted"));
		type("still needed");
		await enter();
		await flush(1_000);
		expect(shown(tab).conversationId).not.toBe(T);
		expect(box()).toBe("still needed");
		expect(statusLine()).toBe(COPY.keptInNewDeleted);
	});

	it("turn-in-progress says it is being answered elsewhere; turn-committed-different-text that an earlier version was sent", async () => {
		const tab = newTab(ORG_A);
		await mountOnThread(tab, crypto.randomUUID());
		server.route.push(refusal("turn-in-progress", true));
		type("status?");
		await enter();
		expect(statusLine()).toContain(COPY.beingAnswered);
		cleanup();
		const other = newTab(ORG_A);
		useElenchStore.setState({ ...INITIAL, conversationId: crypto.randomUUID() });
		await mountOnThread(other, crypto.randomUUID());
		server.route.push(refusal("turn-committed-different-text", true));
		type("an edit");
		await enter();
		expect(statusLine()).toContain(COPY.earlierVersionSent);
	});

	const statuses: [number, string, string][] = [
		[400, "The request's messages are malformed.", "Elench could not read this message."],
		[401, "Unauthorized", "You are signed out. Sign in again in this tab to send it."],
		[413, "too long", "Message too long"],
		[503, "AI is not configured", "AI is not configured"],
		[402, JSON.stringify({ error: "AI limit reached.", reason: "out" }), "AI limit reached."],
	];
	for (const [status, body, said] of statuses)
		it(`a later turn answered ${status} before streaming says why, and Not sent`, async () => {
			const tab = newTab(ORG_A);
			await mountOnThread(tab, crypto.randomUUID());
			server.route.push({ kind: "status", status, body: status === 413 ? (await import("@/lib/ai/message-limits")).MESSAGE_TOO_LONG : body });
			type("plan it");
			await enter();
			expect(statusLine()).toContain(COPY.notSent);
			expect(screen.getAllByText(said).length).toBeGreaterThan(0);
		});

	const starts: [string, Awaited<ReturnType<DraftsTransport["startConversation"]>>, string][] = [
		["unauthorized", { outcome: "unauthorized" }, "You are signed out. Sign in again in this tab to send it."],
		["forbidden", { outcome: "forbidden" }, "You can no longer write here."],
		["rate-limited", { outcome: "rate-limited" }, "Too many requests. Wait a moment, then press Enter to send."],
		["unavailable", { outcome: "unavailable" }, "The service did not answer."],
		["invalid", { outcome: "invalid" }, "This message could not be read."],
		["scope-changed", { outcome: "scope-changed", reason: "other-org" }, "This tab now shows another organization."],
	];
	for (const [name, answer, said] of starts)
		it(`a first send whose start answers ${name} says why, and Not sent`, async () => {
			let first = true;
			const tab = newTab(ORG_A, memoryStorage(), {
				startConversation: async (input) => {
					if (first) {
						first = false;
						return answer;
					}
					return server.transport(() => ORG_A).startConversation(input);
				},
			});
			await mount(tab);
			type("open a ticket");
			await enter();
			await flush();
			expect(statusLine()).toBe(`${said} | ${COPY.notSent}`);
			expect(box()).toBe("open a ticket");
		});

	it("a first send whose start does not answer in 30 s says so, and Not sent", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "hold");
		type("open a ticket");
		await enter();
		await flush(30_000);
		await flush();
		expect(statusLine()).toBe(`Starting the conversation took longer than 30 seconds. | ${COPY.notSent}`);
	});

	it("a claim answered wrong-kind loads the conversation another tab started and says so", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "reject");
		type("restart it");
		await enter();
		const k = shown(tab);
		const claim = server.callsOf("claimDraft")[0] as { turnId: string };
		// A duplicate of this tab sent the same turn, and it was answered.
		server.putThread({
			id: k.conversationId,
			projectId: null,
			title: "restart it",
			messages: [
				{ id: claim.turnId, role: "user", parts: [{ type: "text", text: "restart it" }] },
				{ id: crypto.randomUUID(), role: "assistant", parts: [{ type: "text", text: "restarted" }] },
			],
		});
		await enter(); // the claim answers wrong-kind: the conversation is a stored one now
		await flush();
		expect(statusLine()).toBe(`${COPY.notSent} | ${COPY.transcriptStale}`);
		expect(screen.getAllByText("restarted").length).toBeGreaterThan(0);
		expect(box()).toBe("restart it");
	});

	it("a claim that times out says the server could not be reached, and the words are kept", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("claimDraft", "hold");
		type("scale the workers");
		await enter();
		expect(statusLine()).toBe(COPY.sending);
		await flush(15_000); // the claim's client timeout (D32)
		await flush();
		expect(statusLine()).toBe(COPY.unreachable);
		expect(box()).toBe("scale the workers");
		expect(server.callsOf("releaseClaim")).toMatchObject([{ error: "unreachable" }]);
	});

	it("a start rejected by the network says the server could not be reached, and records why", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("startConversation", "reject");
		type("open a ticket");
		await enter();
		expect(statusLine()).toBe(COPY.unreachable);
		expect(server.callsOf("releaseClaim")).toMatchObject([{ error: "network" }]);
		expect(box()).toBe("open a ticket");
	});

	it("a claim refused for good says why in the footer, and Not sent above the box", async () => {
		const tab = newTab(ORG_A, memoryStorage(), {
			claimDraft: async () => ({ outcome: "limit" }),
		});
		await mount(tab);
		type("one too many");
		await enter();
		expect(statusLine()).toBe(COPY.notSent);
		expect(footer()).toBe(COPY.limit);
	});

	it("a claim answered discarded offers Restore", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		type("half a plan");
		await flush(1_000);
		const k = shown(tab);
		await device().discardDraft({ ...k, baseRevision: server.row(k)?.revision ?? 0 });
		await enter();
		expect(statusLine()).toContain(COPY.discarded);
		await clickBar("Restore");
		await flush(1_000);
		expect(server.row(k)?.state).toBe("active");
		expect(server.row(k)?.content.text).toBe("half a plan");
	});
});

// ── D36, G19 and D25 ──────────────────────────────────────────────────────────────────────────

describe("S11 › the credential notice, the unsaved toasts and leaving", () => {
	const PASTE = "secret: example-value-1234";

	it("a credential-looking paste is not saved until the user answers; Keep in this tab only keeps it out of the account", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		type(PASTE);
		await flush(1_000);
		expect(server.callsOf("saveDraft")).toHaveLength(0);
		expect(statusLine()).toBe(COPY.credential);
		expect(decisionBar()?.getAttribute("role")).toBe("alert");
		expect(asksToLeave()).toBe(true);
		await clickBar("Keep in this tab only");
		expect(decisionBar()).toBeNull();
		expect(footer()).toBe(COPY.keptInTab);
		await flush(1_000);
		expect(server.callsOf("saveDraft")).toHaveLength(0);
		expect(document.activeElement).toBe(screen.getByTestId("elench-composer"));
	});

	it("Save to my account lifts the hold, and the footer says Saved", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		type(PASTE);
		await flush(1_000);
		await clickBar("Save to my account");
		await flush(1_000);
		expect(server.row(shown(tab))?.content.text).toBe(PASTE);
		expect(footer()).toBe(COPY.saved);
		expect(asksToLeave()).toBe(false);
	});

	it("a key that enters an unsaved state is toasted once per entry, naming the conversation", async () => {
		const T = crypto.randomUUID();
		const k: DraftKey = { orgId: ORG_A, projectId: null, conversationId: T };
		// A draft this conversation already has on the server, under its thread's title.
		storedThread(T);
		await device().saveDraft({ ...k, baseRevision: 0, content: { text: "draft", mentions: [], artifacts: [], cellTarget: null }, tabId: "earlier" });
		const row = server.row(k);
		if (row !== undefined) row.title = "first";
		const tab = newTab(ORG_A);
		await mount(tab);
		expect(useElenchStore.getState().conversationId).toBe(T);
		for (let i = 0; i < 3; i++) server.plan("saveDraft", "reject");
		type("first try");
		await flush(1_000);
		await flush(1_000);
		await flush(2_000);
		const unsaved = toasts.shown.filter((t) => t.description === COPY.retrying);
		expect(unsaved).toEqual([{ title: "first", description: COPY.retrying }]); // one entry, one toast
		await flush(10_000); // it recovers …
		expect(server.row(shown(tab))?.content.text).toBe("first try");
		server.plan("saveDraft", "reject");
		type("second try"); // … and enters the state again: a second toast
		await flush(1_000);
		expect(toasts.shown.filter((t) => t.description === COPY.retrying)).toHaveLength(2);
	});

	it("sign-out asks first, naming how many messages would be lost", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		server.plan("saveDraft", "reject");
		type("not saved yet");
		await flush(1_000);
		render(<SidebarProfile />);
		fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
		await flush();
		fireEvent.click(screen.getByRole("menuitem", { name: /Log Out/ }));
		await flush();
		expect(auth.signOut).not.toHaveBeenCalled();
		expect(screen.getByText("1 message is not saved to your account yet and will be lost.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
		await flush();
		expect(auth.signOut).toHaveBeenCalledTimes(1);
	});

	it("sign-out with nothing unsaved signs out at once", async () => {
		const tab = newTab(ORG_A);
		await mount(tab);
		auth.signOut.mockClear();
		render(<SidebarProfile />);
		fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
		await flush();
		fireEvent.click(screen.getByRole("menuitem", { name: /Log Out/ }));
		await flush();
		expect(auth.signOut).toHaveBeenCalledTimes(1);
		expect(screen.queryByText(/not saved to your account yet and will be lost/)).toBeNull();
	});
});

// ── The words, without rendering ───────────────────────────────────────────────────────────

describe("S11 › copy", () => {
	it("an excerpt is one line of at most 60 characters", () => {
		expect(excerpt("a\n  b")).toBe("a b");
		expect(excerpt("x".repeat(80))).toBe(`${"x".repeat(60)}…`);
	});

	it("a code with no reason of its own adds no line", () => {
		expect(notSentReason("error")).toBeNull();
		expect(notSentReason("status-402")).toBeNull();
		expect(notSentReason("thread-busy")).toBeNull();
	});

	it("notice lines are said once each, newest last, at most three", () => {
		const key: DraftKey = { orgId: ORG_A, projectId: null, conversationId: "c" };
		const lines = noticeLines(
			{
				drafts: { viewerId: VIEWER, scope: null, generation: 0, pageOrg: null, activeKey: {}, entries: {}, forks: {}, fences: {} },
				uncached: {},
				notices: [
					{ id: 1, key, notice: "wait-for-send" },
					{ id: 2, key, notice: "empty-box" },
					{ id: 3, key, notice: "wait-for-send" },
					{ id: 4, key, notice: "first-sent" },
					{ id: 5, key, notice: "unsaved" },
					{ id: 6, key: { ...key, conversationId: "other" }, notice: "empty-box" },
				],
			},
			key,
		);
		expect(lines).toEqual([COPY.emptyBox, COPY.waitForSend, COPY.firstSent]);
	});
});
