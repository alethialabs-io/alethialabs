// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A Lexical text node for an @-mention rendered as an atomic, Discord-style pill: token mode
// makes it delete as one unit (a single Backspace removes the whole `@name`), and it carries the
// resolved resource reference ({id, type}) so the composer can hand it to the agent on send.

import {
	$applyNodeReplacement,
	type EditorConfig,
	type LexicalNode,
	type NodeKey,
	type SerializedTextNode,
	type Spread,
	TextNode,
} from "lexical";
import type { MentionType } from "@/lib/ai/mentions";

export type SerializedMentionNode = Spread<
	{ mentionId: string; mentionType: MentionType },
	SerializedTextNode
>;

/** Grayscale chip styling — a tinted, rounded, non-editable token. */
const PILL_CLASS =
	"rounded-[3px] bg-foreground/10 px-1 font-medium text-foreground";

/** A `@name` mention pill carrying its resolved {id, type}. */
export class MentionNode extends TextNode {
	__mentionId: string;
	__mentionType: MentionType;

	static getType(): string {
		return "mention";
	}

	static clone(node: MentionNode): MentionNode {
		return new MentionNode(
			node.__text,
			node.__mentionId,
			node.__mentionType,
			node.__key,
		);
	}

	static importJSON(json: SerializedMentionNode): MentionNode {
		const node = $createMentionNode(json.text, json.mentionId, json.mentionType);
		node.setFormat(json.format);
		node.setDetail(json.detail);
		node.setStyle(json.style);
		return node;
	}

	constructor(
		text: string,
		mentionId: string,
		mentionType: MentionType,
		key?: NodeKey,
	) {
		super(text, key);
		this.__mentionId = mentionId;
		this.__mentionType = mentionType;
	}

	exportJSON(): SerializedMentionNode {
		return {
			...super.exportJSON(),
			mentionId: this.__mentionId,
			mentionType: this.__mentionType,
			type: "mention",
			version: 1,
		};
	}

	createDOM(config: EditorConfig): HTMLElement {
		const dom = super.createDOM(config);
		dom.className = PILL_CLASS;
		dom.setAttribute("data-mention", this.__mentionId);
		return dom;
	}

	/** Treat as an entity so the caret hops over it rather than editing inside. */
	isTextEntity(): true {
		return true;
	}

	canInsertTextBefore(): boolean {
		return false;
	}

	canInsertTextAfter(): boolean {
		return false;
	}
}

/** Create a token-mode mention pill for `@label` referencing (id, type). */
export function $createMentionNode(
	text: string,
	mentionId: string,
	mentionType: MentionType,
): MentionNode {
	const node = new MentionNode(text, mentionId, mentionType);
	node.setMode("token").toggleDirectionless();
	return $applyNodeReplacement(node);
}

/** Narrow a node to a MentionNode. */
export function $isMentionNode(
	node: LexicalNode | null | undefined,
): node is MentionNode {
	return node instanceof MentionNode;
}
