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
import { useCallback, useEffect, useRef, useState } from "react";
import type { Mention } from "@/lib/ai/mentions";
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
	onSend: (text: string, mentions: Mention[]) => void;
	/** Abort the in-flight stream — wired to the Square button while generating. */
	onStop?: () => void;
	placeholder?: string;
	/** Show the model picker (sliders) — org context only. */
	showModel?: boolean;
	status?: ChatStatus;
	autoFocus?: boolean;
}) {
	return (
		<LexicalComposer initialConfig={EDITOR_CONFIG}>
			<ComposerBody {...props} />
		</LexicalComposer>
	);
}

/** Inner body — lives inside the Lexical context so send/Enter can read + clear the editor. */
function ComposerBody({
	onSend,
	onStop,
	placeholder = "Ask Elench, or type @ to tag a resource",
	showModel = false,
	status,
	autoFocus = false,
}: {
	onSend: (text: string, mentions: Mention[]) => void;
	onStop?: () => void;
	placeholder?: string;
	showModel?: boolean;
	status?: ChatStatus;
	autoFocus?: boolean;
}) {
	const [editor] = useLexicalComposerContext();
	const [empty, setEmpty] = useState(true);
	const pending = status === "submitted" || status === "streaming";
	/** The composer box — the mention menu portals into it and opens above it. */
	const boxRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (autoFocus) editor.focus();
	}, [autoFocus, editor]);

	/** Read the editor → plain text + resolved mentions, send, then clear. */
	const submit = useCallback(() => {
		if (pending) return;
		let text = "";
		const seen = new Set<string>();
		const mentions: Mention[] = [];
		editor.getEditorState().read(() => {
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
		if (!trimmed) return;
		onSend(trimmed, mentions);
		editor.update(() => {
			$getRoot().clear();
		});
	}, [editor, onSend, pending]);

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

	const onChange = useCallback((state: EditorState) => {
		state.read(() => setEmpty($getRoot().getTextContent().trim().length === 0));
	}, []);

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
							onClick={pending ? onStop : submit}
							disabled={pending ? !onStop : empty}
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
