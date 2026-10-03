// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The composer's handle is what the thread-start card's Retry calls (#5423 review): it must be
// exactly Enter — send what the box holds now, keep it when the send did not go out — and it
// clears only what was SENT. A first send awaits its thread while the editor stays editable, so
// text typed in that window is not part of the message and must survive the clear.

import { act, render, screen } from "@testing-library/react";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	getNearestEditorFromDOMNode,
	type LexicalEditor,
} from "lexical";
import { createRef, type RefObject } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	ElenchComposer,
	type ElenchComposerHandle,
	type ElenchComposerSubmit,
} from "@/components/agent/elench/elench-composer";

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

/** Replace the composer's content with `text`, as if typed. */
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

/** Call the handle's submit inside act and return what it reported. */
async function submit(ref: RefObject<ElenchComposerHandle | null>) {
	let outcome: ElenchComposerSubmit | undefined;
	await act(async () => {
		outcome = await ref.current?.submit();
	});
	return outcome;
}

describe("ElenchComposer — the submit handle", () => {
	it("sends the current text and clears it once the send went out", async () => {
		const onSend = vi.fn(async () => true);
		const ref = createRef<ElenchComposerHandle>();
		render(<ElenchComposer onSend={onSend} handleRef={ref} />);
		fill("deploy staging, edited");
		expect(await submit(ref)).toBe("sent");
		expect(onSend).toHaveBeenCalledWith("deploy staging, edited", []);
		expect(content()).toBe("");
	});

	it("keeps the text when the send did not go out", async () => {
		const ref = createRef<ElenchComposerHandle>();
		render(<ElenchComposer onSend={async () => false} handleRef={ref} />);
		fill("keep me");
		expect(await submit(ref)).toBe("not-sent");
		expect(content()).toBe("keep me");
	});

	it("reports an empty box as empty and sends nothing", async () => {
		const onSend = vi.fn(async () => true);
		const ref = createRef<ElenchComposerHandle>();
		render(<ElenchComposer onSend={onSend} handleRef={ref} />);
		expect(await submit(ref)).toBe("empty");
		expect(onSend).not.toHaveBeenCalled();
	});

	it("does not erase text typed while the send was in flight", async () => {
		let release: (sent: boolean) => void = () => undefined;
		const onSend = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
		const ref = createRef<ElenchComposerHandle>();
		render(<ElenchComposer onSend={onSend} handleRef={ref} />);
		fill("first part");
		let pending: Promise<ElenchComposerSubmit> | undefined;
		act(() => {
			pending = ref.current?.submit();
		});
		fill("first part, and more typed meanwhile");
		await act(async () => {
			release(true);
			await pending;
		});
		expect(onSend).toHaveBeenCalledWith("first part", []);
		expect(content()).toBe("first part, and more typed meanwhile");
	});
});
