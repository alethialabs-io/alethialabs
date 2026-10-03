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
	$getRoot,
	$nodesOfType,
	COMMAND_PRIORITY_LOW,
	type EditorState,
	KEY_ENTER_COMMAND,
} from "lexical";
import { ArrowUp, Square } from "lucide-react";
import {
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import type { Mention } from "@/lib/ai/mentions";
import { isMessageTooLong, MESSAGE_TOO_LONG } from "@/lib/ai/message-limits";
import { cn } from "@repo/ui/utils";
import {
	ElenchAskMode,
	ElenchDeepReasoning,
	ElenchModelButton,
} from "./elench-controls";
import { $isMentionNode, MentionNode } from "./mention-node";
import { MentionTypeaheadPlugin } from "./mention-typeahead";

/** Stable Lexical config — registers the mention pill node; a render error rethrows to the boundary. */
const EDITOR_CONFIG = {
	namespace: "elench-composer",
	nodes: [MentionNode],
	theme: {},
	onError(error: Error) {
		throw error;
	},
};

/**
 * The Elench composer — a Lexical plain-text editor with Discord-style `@mention` pills. Typing
 * `@` opens a scrollable typeahead ({@link MentionTypeaheadPlugin}); picking a resource drops an
 * atomic pill (one Backspace removes it). On send, the editor state is read into plain text +
 * the resolved `{id, type, label}` references and handed to `onSend` — the same contract the
 * previous textarea used, so callers are unchanged. Ask-mode pill on the left; model settings
 * (org) + send on the right. Used in the modal hero and (via the shared chat) the docked composer.
 */
export function ElenchComposer(props: {
	onSend: ElenchComposerSend;
	/** Abort the in-flight stream — wired to the Square button while generating. */
	onStop?: () => void;
	placeholder?: string;
	/** Show the model picker (sliders) — org context only. */
	showModel?: boolean;
	status?: ChatStatus;
	autoFocus?: boolean;
	/** Lets the caller submit the editor's CURRENT content — the error card's Retry. */
	handleRef?: Ref<ElenchComposerHandle>;
	/**
	 * A serialized editor state to start from, read ONCE at mount (a later change is ignored: a
	 * mounted composer already holds what the user typed). Elench passes a failed first turn's
	 * state here, so a composer remounted by a minimize or maximize shows what Retry would send.
	 */
	seed?: string | null;
}) {
	// Frozen at mount — `initialConfig` is read once by LexicalComposer anyway.
	const [seed] = useState(() => props.seed ?? null);
	return (
		<LexicalComposer
			initialConfig={seed ? { ...EDITOR_CONFIG, editorState: seed } : EDITOR_CONFIG}
		>
			<ComposerBody {...props} />
		</LexicalComposer>
	);
}

/**
 * What the composer hands a message to. Resolving `false` means the message did NOT go out (its
 * conversation could not be started, say): the composer then keeps the text instead of clearing
 * it, so a failed send never loses what the user typed. Anything else clears the editor.
 */
export type ElenchComposerSend = (
	text: string,
	mentions: Mention[],
	/** The editor's serialized state at send time, so a send that fails can be put back as typed. */
	state: string,
) => void | boolean | Promise<boolean>;

/** What a {@link ElenchComposerHandle.submit} did: nothing to send, sent, or not sent (kept). */
export type ElenchComposerSubmit = "empty" | "sent" | "not-sent";

/**
 * The composer, driven from outside. `submit` is EXACTLY what Enter does — read the editor's
 * current text and mentions, send them, clear only when the send went out — so a Retry sends
 * what the user is looking at, edits included, and never discards it.
 */
export interface ElenchComposerHandle {
	submit: () => Promise<ElenchComposerSubmit>;
	/** Replace the editor's content with a serialized state (one `ElenchComposerSend` handed out). */
	restore: (state: string) => void;
}

/** Inner body — lives inside the Lexical context so send/Enter can read + clear the editor. */
function ComposerBody({
	onSend,
	onStop,
	placeholder = "Ask Elench, or type @ to tag a resource",
	showModel = false,
	status,
	autoFocus = false,
	handleRef,
}: {
	onSend: ElenchComposerSend;
	onStop?: () => void;
	placeholder?: string;
	showModel?: boolean;
	status?: ChatStatus;
	autoFocus?: boolean;
	handleRef?: Ref<ElenchComposerHandle>;
}) {
	const [editor] = useLexicalComposerContext();
	const [empty, setEmpty] = useState(true);
	// Over the per-message limit the routes and `createThread` enforce: Send is disabled and the
	// reason is shown under the editor, and the text STAYS so the user can shorten it. Without
	// this an over-limit first message threw inside `startThread` and vanished with no word.
	const [tooLong, setTooLong] = useState(false);
	// A send in progress (its conversation is being created): a second Enter must not send twice.
	const sendingRef = useRef(false);
	const pending = status === "submitted" || status === "streaming";
	/** The composer box — the mention menu portals into it and opens above it. */
	const boxRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (autoFocus) editor.focus();
	}, [autoFocus, editor]);

	/** Read the editor → plain text + resolved mentions, send, then clear — unless the send
	 * reports it did not go out, in which case the text stays for the user to retry. Enter, the
	 * Send button and the caller's {@link ElenchComposerHandle} all come through here. */
	const submit = useCallback(async (): Promise<ElenchComposerSubmit> => {
		// Busy is "not sent": the text stays, and the caller must not treat it as empty.
		if (pending || sendingRef.current) return "not-sent";
		let text = "";
		const state = editor.getEditorState();
		const seen = new Set<string>();
		const mentions: Mention[] = [];
		state.read(() => {
			text = $getRoot().getTextContent();
			for (const node of $nodesOfType(MentionNode)) {
				if (!$isMentionNode(node)) continue;
				const key = `${node.__mentionType}:${node.__mentionId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				mentions.push({
					id: node.__mentionId,
					type: node.__mentionType,
					label: node.getTextContent().replace(/^@/, ""),
				});
			}
		});
		const trimmed = text.trim();
		if (!trimmed) return "empty";
		// Refused here (Enter reaches this even while the button is disabled); the editor is
		// NOT cleared, and the alert below is already on screen.
		if (isMessageTooLong(trimmed)) {
			setTooLong(true);
			return "not-sent";
		}
		sendingRef.current = true;
		let notSent = false;
		try {
			notSent =
				(await onSend(trimmed, mentions, JSON.stringify(state.toJSON()))) === false;
		} finally {
			sendingRef.current = false;
		}
		if (notSent) return "not-sent";
		// Clear only what was sent. A first send awaits its thread, and the editor stays editable
		// meanwhile: text typed in that window is not in the message, so it must not be erased.
		editor.update(() => {
			const root = $getRoot();
			if (root.getTextContent().trim() === trimmed) root.clear();
		});
		return "sent";
	}, [editor, onSend, pending]);
	const restore = useCallback(
		(serialized: string) => {
			editor.setEditorState(editor.parseEditorState(serialized));
		},
		[editor],
	);
	useImperativeHandle(handleRef, () => ({ submit, restore }), [submit, restore]);

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
					void submit();
					return true;
				},
				COMMAND_PRIORITY_LOW,
			),
		[editor, submit],
	);

	const onChange = useCallback((state: EditorState) => {
		state.read(() => {
			const text = $getRoot().getTextContent().trim();
			setEmpty(text.length === 0);
			setTooLong(isMessageTooLong(text));
		});
	}, []);
	// `OnChangePlugin` skips the initial state, so a composer that mounts seeded (see `seed`)
	// reads it once here — otherwise Send would stay disabled over a box that holds text.
	useEffect(() => {
		onChange(editor.getEditorState());
	}, [editor, onChange]);

	return (
		// The mention menu is portaled in here and opens UPWARD from the top of this box, so it
		// never covers the text you're typing (it used to be anchored at the caret).
		<div ref={boxRef} className="relative">
			<div className="border border-border bg-background shadow-sm focus-within:ring-3 focus-within:ring-ring/25">
				<div className="relative">
					<PlainTextPlugin
						contentEditable={
							<ContentEditable
								data-testid="elench-composer"
								aria-label="Message Elench"
								aria-placeholder={placeholder}
								placeholder={
									<div className="pointer-events-none absolute left-3.5 top-3 text-sm text-muted-foreground">
										{placeholder}
									</div>
								}
								className="max-h-56 min-h-[72px] w-full overflow-y-auto whitespace-pre-wrap break-words px-3.5 py-3 text-sm text-foreground outline-none"
							/>
						}
						ErrorBoundary={LexicalErrorBoundary}
					/>
					<OnChangePlugin onChange={onChange} />
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
							disabled={pending ? !onStop : empty || tooLong}
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
		</div>
	);
}
