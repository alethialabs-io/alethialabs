// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The composer's editor <-> a draft's `{ text, mentions }` (ADR 0001 §4.1). A draft stores no
// Lexical JSON: `contentToEditor` rebuilds the editor from the text and its pill spans, and
// `editorToContent` reads them back with one span per pill. A property test pins the round trip
// in both directions (tests/components/elench-draft-editor.test.ts).

import {
	$createLineBreakNode,
	$createParagraphNode,
	$createTabNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	type EditorState,
	type LexicalNode,
} from "lexical";
import type { DraftEditorContent, DraftMention } from "@/lib/elench/draft-content";
import { $createMentionNode, $isMentionNode } from "./mention-node";

/**
 * Appends the plain text `gap` to `out` as the editor's own nodes: a line break per `\n`, a
 * tab node per `\t`, and text nodes between. It splits on exactly those two characters, unlike
 * Lexical's `insertRawText`, which also folds `\r\n` into one line break: a draft's `\r\n` must
 * come back as `\r\n`, or every span after it would move.
 */
function $appendGap(out: LexicalNode[], gap: string): void {
	for (const piece of gap.split(/(\n|\t)/)) {
		if (piece === "") continue;
		if (piece === "\n") out.push($createLineBreakNode());
		else if (piece === "\t") out.push($createTabNode());
		else out.push($createTextNode(piece));
	}
}

/**
 * Replaces the editor's content with `content`: one paragraph holding the gaps as text and each
 * span as a mention pill whose text is `"@" + label`. Runs inside an editor update. The caller
 * is trusted to pass content that satisfies the span rules (`contentSchema` checks them); a span
 * that does not fit the text is written as plain text rather than lost.
 */
function $writeDraftContent(content: DraftEditorContent): void {
	const nodes: LexicalNode[] = [];
	let cursor = 0;
	for (const span of content.mentions) {
		const pill = `@${span.label}`;
		if (
			span.start < cursor ||
			content.text.slice(span.start, span.end) !== pill
		) {
			continue;
		}
		$appendGap(nodes, content.text.slice(cursor, span.start));
		nodes.push($createMentionNode(pill, span.id, span.type));
		cursor = span.end;
	}
	$appendGap(nodes, content.text.slice(cursor));
	const paragraph = $createParagraphNode();
	paragraph.append(...nodes);
	const root = $getRoot();
	root.clear();
	root.append(paragraph);
	if ($getSelection() !== null) paragraph.selectEnd();
}

/**
 * The editor updater that rebuilds the editor from `content`. Usable both as a composer's
 * `initialConfig.editorState` and as `editor.update(contentToEditor(content))`.
 */
export function contentToEditor(content: DraftEditorContent): () => void {
	return () => $writeDraftContent(content);
}

/** The text a walk has read so far, and the pill spans found in it. */
interface Walk {
	text: string;
	mentions: DraftMention[];
}

/**
 * Reads `node` into `walk` in document order, with the same text `getTextContent` gives: block
 * children of an element are separated by a blank line. A mention pill becomes a span; one whose
 * text is not `@` and a label (which no typeahead makes) is read as plain text.
 */
function $readNode(node: LexicalNode, walk: Walk): void {
	if ($isElementNode(node)) {
		const children = node.getChildren();
		children.forEach((child, index) => {
			$readNode(child, walk);
			if ($isElementNode(child) && index !== children.length - 1 && !child.isInline()) {
				walk.text += "\n\n";
			}
		});
		return;
	}
	const text = node.getTextContent();
	if ($isMentionNode(node) && text.length > 1 && text.startsWith("@")) {
		walk.mentions.push({
			id: node.__mentionId,
			type: node.__mentionType,
			label: text.slice(1),
			start: walk.text.length,
			end: walk.text.length + text.length,
		});
	}
	walk.text += text;
}

/** Reads the current editor into `{ text, mentions }`, one span per pill. Runs inside a read. */
function $readDraftContent(): DraftEditorContent {
	const walk: Walk = { text: "", mentions: [] };
	$readNode($getRoot(), walk);
	return walk;
}

/**
 * The `{ text, mentions }` an editor state holds, one span per pill, in document order. The text
 * is the editor's own `getTextContent()`, unnormalized and untrimmed: normalization runs on input,
 * before this is read, so the spans always index the text that is stored.
 */
export function editorToContent(state: EditorState): DraftEditorContent {
	return state.read($readDraftContent);
}
