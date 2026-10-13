// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench composer refuses an over-limit message VISIBLY and keeps it (#5423), and since ADR
// 0001 slice 9 it caps ONE string: the box as typed, untrimmed (§4.1, R6), so a message the box
// allows always saves and always passes the routes' 413; the send trims and only shortens it. It
// also normalizes on input and paste (U+0000 and lone surrogates never reach the store). The
// composer here is the real one over a real drafts store, whose server is the in-memory fake; the
// editor is filled through Lexical's own API (jsdom cannot type 100k characters in reasonable
// time), and the controls and the @-mention typeahead are stubbed.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	getNearestEditorFromDOMNode,
	KEY_ENTER_COMMAND,
	type LexicalEditor,
} from "lexical";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElenchComposer } from "@/components/agent/elench/elench-composer";
import { createDraftsTab, type DraftsTab } from "@/components/agent/elench/elench-drafts-root";
import { ElenchDraftContext } from "@/components/agent/elench/use-elench-send";
import { MAX_USER_MESSAGE_CHARS, MESSAGE_TOO_LONG } from "@/lib/ai/message-limits";
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

/** A tab's store over the fake server, its scope listed and KEY selected (a new conversation). */
async function renderComposer(): Promise<void> {
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
	render(
		<ElenchDraftContext.Provider value={{ store: tab.store, key: KEY }}>
			<ElenchComposer status="ready" />
		</ElenchDraftContext.Provider>,
	);
	await act(async () => {});
}

/** The live Lexical editor behind the rendered composer. */
function composerEditor(): LexicalEditor {
	const editor = getNearestEditorFromDOMNode(screen.getByTestId("elench-composer"));
	if (!editor) throw new Error("the composer has no Lexical editor");
	return editor;
}

/** Replace the composer's content with `text`, as if typed or pasted. */
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

/** The draft's text as the store holds it. */
function stored(): string | undefined {
	const e = tab.store.view.getState().drafts.entries[keyId(KEY)];
	return (e?.local ?? e?.server?.content)?.text;
}

beforeEach(async () => {
	await renderComposer();
});

describe("ElenchComposer — the per-message limit", () => {
	it("refuses one character over the limit visibly, sends nothing, and keeps the text", async () => {
		const over = "a".repeat(MAX_USER_MESSAGE_CHARS + 1);
		fill(over);

		const alert = screen.getByTestId("elench-composer-too-long");
		expect(alert).toHaveAttribute("role", "alert");
		expect(alert).toHaveTextContent(MESSAGE_TOO_LONG);
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

		// Enter reaches the send even while the button is disabled — it must refuse too.
		act(() => {
			composerEditor().dispatchCommand(KEY_ENTER_COMMAND, null);
		});
		await act(async () => {});
		expect(server.callsOf("claimDraft")).toHaveLength(0);
		expect(content()).toBe(over);
	});

	it("caps the untrimmed box: a message of the limit plus a trailing newline is refused here, never by the server", async () => {
		fill(`${"a".repeat(MAX_USER_MESSAGE_CHARS)}\n`);
		expect(screen.getByTestId("elench-composer-too-long")).toBeInTheDocument();
		act(() => {
			composerEditor().dispatchCommand(KEY_ENTER_COMMAND, null);
		});
		await act(async () => {});
		expect(server.callsOf("claimDraft")).toHaveLength(0);
	});

	it("sends a message of exactly the limit, with no alert", async () => {
		const user = userEvent.setup();
		const atLimit = "a".repeat(MAX_USER_MESSAGE_CHARS);
		fill(atLimit);

		expect(screen.queryByTestId("elench-composer-too-long")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(server.callsOf("claimDraft")).toMatchObject([{ content: { text: atLimit } }]);
	});

	it("clears the alert once the message is shortened back under the limit", () => {
		fill("a".repeat(MAX_USER_MESSAGE_CHARS + 1));
		expect(screen.getByTestId("elench-composer-too-long")).toBeInTheDocument();
		fill("short");
		expect(screen.queryByTestId("elench-composer-too-long")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
	});
});

describe("ElenchComposer — normalization on input and paste (§4.1)", () => {
	it("drops U+0000 and repairs a lone surrogate in the box itself, before the store reads it", () => {
		fill("ab\u0000c \ud800 d");
		expect(content()).toBe("abc � d");
		expect(stored()).toBe("abc � d");
	});
});
