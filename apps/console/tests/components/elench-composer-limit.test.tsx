// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Elench composer refuses an over-limit message VISIBLY and keeps it (#5423). Before this, a
// first message over the cap `createThread` enforces threw inside `startThread`, which `onSend`
// awaits before `sendMessage` — so the send was dropped with no message and no error on screen.
// The limit is the one the chat routes 413 on (lib/ai/message-limits.ts). The editor is filled
// through Lexical's own API (jsdom cannot type 100k characters in reasonable time); the
// controls and the @-mention typeahead are stubbed, as they read stores and server actions.

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
import { describe, expect, it, vi } from "vitest";
import { ElenchComposer } from "@/components/agent/elench/elench-composer";
import { MAX_USER_MESSAGE_CHARS, MESSAGE_TOO_LONG } from "@/lib/ai/message-limits";

vi.mock("@/components/agent/elench/elench-controls", () => ({
	ElenchAskMode: () => null,
	ElenchDeepReasoning: () => null,
	ElenchModelButton: () => null,
}));
vi.mock("@/components/agent/elench/mention-typeahead", () => ({
	MentionTypeaheadPlugin: () => null,
}));

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

describe("ElenchComposer — the per-message limit", () => {
	it("refuses one character over the limit visibly, sends nothing, and keeps the text", () => {
		const onSend = vi.fn();
		render(<ElenchComposer onSend={onSend} status="ready" />);
		const over = "a".repeat(MAX_USER_MESSAGE_CHARS + 1);
		fill(over);

		const alert = screen.getByTestId("elench-composer-too-long");
		expect(alert).toHaveAttribute("role", "alert");
		expect(alert).toHaveTextContent(MESSAGE_TOO_LONG);
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

		// Enter reaches `submit` even while the button is disabled — it must refuse too.
		act(() => {
			composerEditor().dispatchCommand(KEY_ENTER_COMMAND, null);
		});
		expect(onSend).not.toHaveBeenCalled();
		expect(content()).toBe(over);
	});

	it("sends a message of exactly the limit, with no alert", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn();
		render(<ElenchComposer onSend={onSend} status="ready" />);
		const atLimit = "a".repeat(MAX_USER_MESSAGE_CHARS);
		fill(atLimit);

		expect(screen.queryByTestId("elench-composer-too-long")).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(onSend).toHaveBeenCalledWith(atLimit, [], expect.any(String));
	});

	it("clears the alert once the message is shortened back under the limit", () => {
		render(<ElenchComposer onSend={vi.fn()} status="ready" />);
		fill("a".repeat(MAX_USER_MESSAGE_CHARS + 1));
		expect(screen.getByTestId("elench-composer-too-long")).toBeInTheDocument();
		fill("short");
		expect(screen.queryByTestId("elench-composer-too-long")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
	});
});

// #5423 review: a send that did NOT go out (its conversation could not be started) must leave
// the text in the composer — clearing it first is what lost the message.
describe("ElenchComposer — a send that did not go out", () => {
	it("keeps the text when onSend resolves false", async () => {
		const user = userEvent.setup();
		const onSend = vi.fn(async () => false);
		render(<ElenchComposer onSend={onSend} status="ready" />);
		fill("keep me");
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(onSend).toHaveBeenCalledWith("keep me", [], expect.any(String));
		expect(content()).toBe("keep me");
	});

	it("clears the text once onSend resolves true", async () => {
		const user = userEvent.setup();
		render(<ElenchComposer onSend={vi.fn(async () => true)} status="ready" />);
		fill("sent");
		await user.click(screen.getByRole("button", { name: "Send" }));
		expect(content()).toBe("");
	});
});
