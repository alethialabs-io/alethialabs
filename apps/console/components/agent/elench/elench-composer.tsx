"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChatStatus } from "ai";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
	BLUR_COMMAND,
	COMMAND_PRIORITY_LOW,
	type EditorState,
	KEY_ENTER_COMMAND,
	TextNode,
} from "lexical";
import { ArrowUp, Square } from "lucide-react";
import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { type DraftEditorContent, normalizeDraftText } from "@/lib/elench/draft-content";
import { isMessageTooLong, MESSAGE_TOO_LONG } from "@/lib/ai/message-limits";
import { EMPTY_CONTENT, shownContent } from "@/lib/stores/elench-drafts/reducer-drafting";
import type { DraftEntry } from "@/lib/stores/elench-drafts/types";
import { cn } from "@repo/ui/utils";
import { DraftBarSlot, DraftFooterSlot } from "./draft-status/slots";
import { contentToEditor, editorToContent } from "./draft-editor";
import {
	ElenchAskMode,
	ElenchDeepReasoning,
	ElenchModelButton,
} from "./elench-controls";
import { MentionNode } from "./mention-node";
import { MentionTypeaheadPlugin } from "./mention-typeahead";
import { type ElenchDraftBinding, useDraftEntry, useElenchDraft, useElenchSend } from "./use-elench-send";

/** Stable Lexical config — registers the mention pill node; a render error rethrows to the boundary. */
const EDITOR_CONFIG = {
	namespace: "elench-composer",
	nodes: [MentionNode],
	theme: {},
	onError(error: Error) {
		throw error;
	},
};

/** The tag of an update that reseeds the editor from the store: it is not the user's edit. */
const RESEED_TAG = "elench-draft-reseed";

/**
 * The Elench composer — a Lexical plain-text editor with Discord-style `@mention` pills, and a
 * VIEW of the conversation's draft in the drafts store (ADR 0001 §7.1): it seeds from the draft
 * when it mounts, reseeds whenever the draft's `epoch` moves (the box was replaced from outside,
 * I6), and reports every edit back as `EDIT` stamped with the epoch it was seeded at, so a stale
 * edit is dropped by the store. Nothing typed lives only here, so a minimize, a maximize, the
 * landing giving way to the transcript, a close or a reload loses none of it.
 *
 * Enter is `SUBMIT` (D9 / D10): the store claims exactly what the box shows, trims it and sends it,
 * and a refused or failed send puts the words back here. The box is read-only while the claim is
 * pending (one round trip) and while another tab or device is sending the same draft (D30).
 * Rendered inside a conversation, which provides the draft; without one it is read-only.
 */
export function ElenchComposer(props: {
	/** Abort the in-flight stream — wired to the Square button while generating. */
	onStop?: () => void;
	placeholder?: string;
	/** Show the model picker (sliders) — org context only. */
	showModel?: boolean;
	status?: ChatStatus;
	autoFocus?: boolean;
	/** Lets the caller drive the box: Enter (`submit`). */
	handleRef?: Ref<ElenchComposerHandle>;
}) {
	const draft = useElenchDraft();
	const entry = useDraftEntry(draft);
	// Read once: LexicalComposer reads `initialConfig` at mount; later content arrives by reseeding.
	const [seed] = useState(() => (entry === null ? EMPTY_CONTENT : shownContent(entry)));
	return (
		<LexicalComposer
			initialConfig={{ ...EDITOR_CONFIG, editorState: contentToEditor(seed) }}
		>
			<ComposerBody {...props} draft={draft} entry={entry} seededAt={entry?.epoch ?? null} />
		</LexicalComposer>
	);
}

/** The composer, driven from outside. */
export interface ElenchComposerHandle {
	/** EXACTLY what Enter does: `SUBMIT` of what the box shows. False when there is no draft. */
	submit: () => boolean;
}

/** True when the box may be typed into: a draft exists, no claim is pending, no other tab sends it. */
function editableEntry(entry: DraftEntry | null): boolean {
	return entry !== null && entry.claiming === null && entry.conflict?.kind !== "claimed";
}

/** True when two editor contents are the same text and the same pills at the same places. */
function sameEditorContent(a: DraftEditorContent, b: DraftEditorContent): boolean {
	return (
		a.text === b.text &&
		a.mentions.length === b.mentions.length &&
		a.mentions.every(
			(m, i) =>
				m.id === b.mentions[i].id &&
				m.type === b.mentions[i].type &&
				m.label === b.mentions[i].label &&
				m.start === b.mentions[i].start &&
				m.end === b.mentions[i].end,
		)
	);
}

/** Inner body — lives inside the Lexical context so it can read, reseed and lock the editor. */
function ComposerBody({
	onStop,
	placeholder = "Ask Elench, or type @ to tag a resource",
	showModel = false,
	status,
	autoFocus = false,
	handleRef,
	draft,
	entry,
	seededAt,
}: {
	onStop?: () => void;
	placeholder?: string;
	showModel?: boolean;
	status?: ChatStatus;
	autoFocus?: boolean;
	handleRef?: Ref<ElenchComposerHandle>;
	draft: ElenchDraftBinding | null;
	entry: DraftEntry | null;
	seededAt: number | null;
}) {
	const [editor] = useLexicalComposerContext();
	const send = useElenchSend(draft, status);
	const shown = entry === null ? EMPTY_CONTENT : shownContent(entry);
	const empty = shown.text.trim().length === 0;
	// The ONE string capped everywhere (§4.1, R6): the box as typed, untrimmed. A message the box
	// allows always saves and is never refused by the routes' 413; trimming at send only shortens it.
	const tooLong = isMessageTooLong(shown.text);
	const editable = editableEntry(entry);
	const pending = status === "submitted" || status === "streaming";
	/** The composer box — the mention menu portals into it and opens above it. */
	const boxRef = useRef<HTMLDivElement>(null);
	// The epoch the editor was last seeded at (I6): every EDIT is stamped with it, so an edit made
	// against content the store has since replaced is dropped instead of overwriting it.
	const epochRef = useRef<number | null>(seededAt);
	// What the editor last held as the store knows it, so a reseed or a selection move is no edit.
	const lastRef = useRef<DraftEditorContent>({ text: shown.text, mentions: shown.mentions });

	useEffect(() => {
		if (autoFocus) editor.focus();
	}, [autoFocus, editor]);

	// Reseed whenever the store replaced the box from outside (its epoch moved), once the draft first
	// exists, and to empty when it is gone (D25 cleared the tab): the box never shows words the store
	// no longer holds. Never on the user's own edits, which never move the epoch.
	const epoch = entry?.epoch ?? null;
	const present = entry !== null;
	useEffect(() => {
		if (entry === null) {
			if (epochRef.current === null) return;
			epochRef.current = null;
			lastRef.current = { text: "", mentions: [] };
			editor.update(contentToEditor(EMPTY_CONTENT), { tag: RESEED_TAG });
			return;
		}
		if (epochRef.current === entry.epoch) return;
		const content = shownContent(entry);
		epochRef.current = entry.epoch;
		lastRef.current = { text: content.text, mentions: content.mentions };
		editor.update(contentToEditor(content), { tag: RESEED_TAG });
		// eslint-disable-next-line react-hooks/exhaustive-deps -- `entry` changes on every keystroke; only an epoch move reseeds
	}, [editor, epoch, present]);

	useEffect(() => {
		editor.setEditable(editable);
	}, [editor, editable]);

	// §4.1: the box never shows a character Postgres would refuse (U+0000) or change (a lone
	// surrogate). Normalized on input and paste, in the editor, before any span is read.
	useEffect(
		() =>
			editor.registerNodeTransform(TextNode, (node) => {
				const text = node.getTextContent();
				const normalized = normalizeDraftText(text);
				if (normalized !== text) node.setTextContent(normalized);
			}),
		[editor],
	);

	/** D5: the user's edit, stamped with the epoch the editor was seeded at. */
	const onChange = useCallback(
		(state: EditorState, _editor: unknown, tags: Set<string>) => {
			if (tags.has(RESEED_TAG) || draft === null || epochRef.current === null) return;
			const content = editorToContent(state);
			if (sameEditorContent(content, lastRef.current)) return;
			lastRef.current = content;
			draft.store.dispatch({
				type: "ENTRY",
				key: draft.key,
				event: { type: "EDIT", epoch: epochRef.current, content },
			});
		},
		[draft],
	);

	const submit = useCallback((): boolean => send.submit(), [send]);
	useImperativeHandle(handleRef, () => ({ submit }), [submit]);

	// Enter sends (Shift+Enter = newline). Registered LOW so the mention typeahead (NORMAL) wins
	// when it has a selectable option — its handler consumes Enter to pick, so this never runs.
	// When the menu has no option (or is closed) the plugin DECLINES Enter and it reaches here to
	// send. We deliberately do NOT gate on a "menu open" flag: the plugin already does the right
	// thing by priority, and a stale flag once trapped `@mention`-in-the-middle messages so Enter
	// only inserted a newline and the message never sent.
	useEffect(
		() =>
			editor.registerCommand(
				KEY_ENTER_COMMAND,
				(event) => {
					if (event?.shiftKey) return false;
					event?.preventDefault();
					submit();
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
		[editor, submit],
	);

	// D7: a blur saves at once instead of waiting out the debounce.
	useEffect(
		() =>
			editor.registerCommand(
				BLUR_COMMAND,
				() => {
					if (draft !== null)
						draft.store.dispatch({
							type: "ENTRY",
							key: draft.key,
							event: { type: "SAVE_TRIGGER", reason: "blur" },
						});
					return false;
				},
				COMMAND_PRIORITY_LOW,
			),
		[editor, draft],
	);

	return (
		// The mention menu is portaled in here and opens UPWARD from the top of this box, so it
		// never covers the text you're typing (it used to be anchored at the caret).
		<div ref={boxRef} className="relative">
			{draft !== null && <DraftBarSlot draftKey={draft.key} />}
			<div className="border border-border bg-background shadow-sm focus-within:ring-3 focus-within:ring-ring/25">
				<div className="relative">
					<PlainTextPlugin
						contentEditable={
							<ContentEditable
								data-testid="elench-composer"
								aria-label="Message Elench"
								aria-placeholder={placeholder}
								aria-readonly={!editable}
								placeholder={
									<div className="pointer-events-none absolute left-3.5 top-3 text-sm text-muted-foreground">
										{placeholder}
									</div>
								}
								className={cn(
									"max-h-56 min-h-[72px] w-full overflow-y-auto whitespace-pre-wrap break-words px-3.5 py-3 text-sm text-foreground outline-none",
									!editable && "cursor-default",
								)}
							/>
						}
						ErrorBoundary={LexicalErrorBoundary}
					/>
					<OnChangePlugin onChange={onChange} ignoreSelectionChange />
					<HistoryPlugin />
					<MentionTypeaheadPlugin boxRef={boxRef} />
				</div>
				{tooLong && (
					<p
						role="alert"
						data-testid="elench-composer-too-long"
						className="px-3.5 pb-1 text-ui-xs text-destructive"
					>
						{MESSAGE_TOO_LONG} Shorten it to send.
					</p>
				)}
				<div className="flex items-center justify-between px-2.5 pb-2.5">
					<div className="flex items-center gap-1.5">
						<ElenchAskMode />
						{/* Max-only per-message Opus opt-in (org context); the control self-hides otherwise. */}
						{showModel && <ElenchDeepReasoning />}
					</div>
					<div className="flex items-center gap-1">
						{showModel && <ElenchModelButton />}
						<button
							type="button"
							aria-label={pending && onStop ? "Stop" : "Send"}
							onClick={pending ? onStop : () => void submit()}
							disabled={pending ? !onStop : empty || tooLong || !editable}
							className="flex size-8 items-center justify-center bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
						>
							{pending ? (
								<Square className="h-3.5 w-3.5" />
							) : (
								<ArrowUp className="h-4 w-4" />
							)}
						</button>
					</div>
				</div>
			</div>
			{draft !== null && <DraftFooterSlot draftKey={draft.key} />}
		</div>
	);
}
