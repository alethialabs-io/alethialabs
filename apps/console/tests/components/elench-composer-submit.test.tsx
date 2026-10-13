// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The composer is a VIEW of its conversation's draft (ADR 0001 §7.1, slice 9): it seeds from the
// draft when it mounts, reseeds when the store replaces the box from outside (`epoch`, I6), stamps
// every edit with the epoch it was seeded at, is read-only while a claim is pending, and its Enter
// and its handle's `submit` are one `SUBMIT`. Its handle's `restore` puts words back as if typed.
// The composer is the real one over a real drafts store whose server is the in-memory fake.

import { act, render, screen } from "@testing-library/react";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	getNearestEditorFromDOMNode,
	KEY_ENTER_COMMAND,
	type LexicalEditor,
} from "lexical";
import { createRef, type RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElenchComposer, type ElenchComposerHandle } from "@/components/agent/elench/elench-composer";
import { createDraftsTab, type DraftsTab } from "@/components/agent/elench/elench-drafts-root";
import { ElenchDraftContext } from "@/components/agent/elench/use-elench-send";
import { keyId } from "@/lib/stores/elench-drafts/reducer-drafting";
import type { DraftKey } from "@/lib/stores/elench-drafts/types";
import { FakeElenchServer } from "@/tests/fixtures/elench-drafts-server";

vi.mock("@/components/agent/elench/elench-controls", () => ({
	ElenchAskMode: () => null,
	ElenchDeepReasoning: () => null,
	ElenchModelButton: () => null,
}));
vi.mock("@/components/agent/elench/mention-typeahead", () => ({
	MentionTypeaheadPlugin: () => null,
}));
// The real actions are server code; the store here is handed the fake server's transport.
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

const ORG = "00000000-0000-4000-8000-00000000000a";
const KEY: DraftKey = { orgId: ORG, projectId: null, conversationId: "00000000-0000-4000-8000-0000000000c1" };

let server: FakeElenchServer;
let tab: DraftsTab;

/** A store over the fake server with KEY's scope listed and KEY selected (a new conversation). */
async function newStore(): Promise<void> {
	server = new FakeElenchServer();
	tab = createDraftsTab({
		viewerId: "00000000-0000-4000-8000-0000000000aa",
		transport: server.transport(() => ORG),
		heartbeat: async () => Response.json({ outcome: "touched" }),
		storage: () => null,
		tabId: "tab-1",
		mint: () => crypto.randomUUID(),
	});
	tab.store.load({ orgId: ORG, projectId: null });
	await act(async () => {});
	tab.store.dispatch({ type: "SELECT", key: KEY, thread: "none" });
}

/** Mounts a composer on KEY; returns its handle. */
async function mountComposer(): Promise<{ handle: RefObject<ElenchComposerHandle | null>; unmount: () => void }> {
	const handle = createRef<ElenchComposerHandle>();
	const r = render(
		<ElenchDraftContext.Provider value={{ store: tab.store, key: KEY }}>
			<ElenchComposer status="ready" handleRef={handle} />
		</ElenchDraftContext.Provider>,
	);
	await act(async () => {});
	return { handle, unmount: r.unmount };
}

/** The live Lexical editor behind the rendered composer. */
function composerEditor(): LexicalEditor {
	const editor = getNearestEditorFromDOMNode(screen.getByTestId("elench-composer"));
	if (!editor) throw new Error("the composer has no Lexical editor");
	return editor;
}

/** Replace the composer's content with `text`, as if typed. */
function fill(text: string) {
	act(() => {
		composerEditor().update(
			() => {
				const root = $getRoot();
				root.clear();
				root.append($createParagraphNode().append($createTextNode(text)));
			},
			{ discrete: true },
		);
	});
}

/** The composer's current plain text. */
function content(): string {
	return composerEditor().getEditorState().read(() => $getRoot().getTextContent());
}

/** KEY's entry. */
function entry() {
	return tab.store.view.getState().drafts.entries[keyId(KEY)];
}

beforeEach(async () => {
	await newStore();
});

describe("ElenchComposer — a view of the draft", () => {
	it("every edit goes to the store, stamped with the epoch the box was seeded at", async () => {
		await mountComposer();
		fill("deploy");
		expect(entry()?.local?.text).toBe("deploy");
	});

	it("a composer that mounts later (a minimize, a maximize, the landing giving way) shows the draft", async () => {
		const first = await mountComposer();
		fill("keep me across the remount");
		first.unmount();
		await mountComposer();
		expect(content()).toBe("keep me across the remount");
	});

	it("reseeds when the store replaces the box from outside, and an edit seeded before it is dropped", async () => {
		await mountComposer();
		fill("mine");
		const before = entry()?.epoch ?? -1;
		// An editor seeded before the box was last replaced from outside: its edit is stale.
		act(() =>
			tab.store.dispatch({
				type: "ENTRY",
				key: KEY,
				event: { type: "EDIT", epoch: before - 1, content: { text: "stale editor", mentions: [] } },
			}),
		);
		expect(entry()?.local?.text).toBe("mine"); // a stale-epoch edit changes nothing (I6)
		server.plan("startConversation", "reject");
		act(() => {
			composerEditor().dispatchCommand(KEY_ENTER_COMMAND, null);
		});
		await act(async () => {});
		await act(async () => {});
		// The claim emptied the box, the failed start's release put the words back: both from outside.
		expect((entry()?.epoch ?? 0) > before).toBe(true);
		expect(content()).toBe("mine");
	});
});

describe("ElenchComposer — the submit handle", () => {
	it("submit is Enter: it claims exactly what the box shows, and the box is read-only while the claim is pending", async () => {
		const { handle } = await mountComposer();
		fill("ship it");
		server.plan("claimDraft", "hold");
		act(() => {
			expect(handle.current?.submit()).toBe(true);
		});
		expect(server.callsOf("claimDraft")).toMatchObject([{ content: { text: "ship it" }, kind: "first" }]);
		expect(composerEditor().isEditable()).toBe(false);
		expect(screen.getByTestId("elench-composer")).toHaveAttribute("aria-readonly", "true");
		await act(async () => server.release("claimDraft"));
		await act(async () => {});
		expect(composerEditor().isEditable()).toBe(true);
		expect(content()).toBe(""); // the claim was granted: the box empties (I1)
	});

	it("an empty box sends nothing", async () => {
		const { handle } = await mountComposer();
		act(() => {
			handle.current?.submit();
		});
		await act(async () => {});
		expect(server.callsOf("claimDraft")).toHaveLength(0);
	});
});
