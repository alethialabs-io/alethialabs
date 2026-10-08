// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// ADR 0001 §4.1: a draft stores `{ text, mentions }`, never Lexical JSON, so the composer's editor
// must be rebuilt from the text and its spans exactly. These tests pin the round trip in both
// directions on the real (pinned) Lexical, headless.
//
// The property tests use a seeded generator loop rather than fast-check, which is not a
// dependency of the console: a failure names its seed, and the same seed replays it.

import {
	$createLineBreakNode,
	$createParagraphNode,
	$createTabNode,
	$createTextNode,
	$getRoot,
	$isElementNode,
	$isLineBreakNode,
	$isTabNode,
	createEditor,
	type LexicalEditor,
	type LexicalNode,
} from "lexical";
import { describe, expect, it } from "vitest";
import { MENTION_TYPES } from "@/lib/ai/mentions";
import { MAX_USER_MESSAGE_CHARS } from "@/lib/ai/message-limits";
import {
	contentToEditor,
	editorToContent,
} from "@/components/agent/elench/draft-editor";
import {
	$createMentionNode,
	$isMentionNode,
	MentionNode,
} from "@/components/agent/elench/mention-node";
import {
	contentSchema,
	type DraftEditorContent,
	type DraftMention,
	MAX_DRAFT_MENTION_FIELD,
	MAX_DRAFT_MENTION_SPANS,
	spansAreValid,
} from "@/lib/elench/draft-content";

/** A deterministic PRNG (mulberry32): the same seed gives the same sequence. */
function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** One of `items`, chosen by `next`. */
function pick<T>(next: () => number, items: readonly T[]): T {
	const item = items[Math.floor(next() * items.length)];
	if (item === undefined) throw new Error("pick from an empty list");
	return item;
}

/**
 * Normalized text units (a surrogate PAIR is one unit here, so a gap is always well-formed).
 * `\r\n` and a lone `\r` are in on purpose: Lexical's `insertRawText` folds `\r\n` into one line
 * break, which would move every span after it.
 */
const TEXT_UNITS = [
	"a", "b", " ", "@", "\n", "\r", "\r\n", "\t", "\u0001", "\uD83D\uDE00", "中", "-",
];

/** Units a mention label may hold: what a resource name or a typed label can carry. */
const LABEL_UNITS = ["w", "e", "b", "-", " ", "@", "\uD83D\uDE00", "中", "\t", "\n"];

/** A random string of `min` to `max` units drawn from `units`. */
function randomString(
	next: () => number,
	units: readonly string[],
	min: number,
	max: number,
): string {
	let out = "";
	const length = min + Math.floor(next() * (max - min + 1));
	for (let i = 0; i < length; i++) out += pick(next, units);
	return out;
}

/** A small pool of mentions, so repeats of one resource happen (one span per pill). */
const IDS = ["p1", "p2", "c1", "uuid-like-0f3e", "x"];

/** A random valid `{ text, mentions }`: gaps and pills interleaved, so spans hold by construction. */
function randomContent(next: () => number): DraftEditorContent {
	let text = "";
	const mentions: DraftMention[] = [];
	const pills = Math.floor(next() * 8);
	for (let i = 0; i < pills; i++) {
		text += randomString(next, TEXT_UNITS, 0, 6);
		const label = randomString(next, LABEL_UNITS, 1, 5);
		const start = text.length;
		text += `@${label}`;
		mentions.push({
			id: pick(next, IDS),
			type: pick(next, MENTION_TYPES),
			label,
			start,
			end: text.length,
		});
	}
	text += randomString(next, TEXT_UNITS, 0, 6);
	return { text, mentions };
}

/** A headless editor with the composer's nodes. */
function newEditor(): LexicalEditor {
	return createEditor({
		namespace: "draft-editor-test",
		nodes: [MentionNode],
		onError: (error) => {
			throw error;
		},
	});
}

/** Writes `content` into a fresh editor with `contentToEditor`. */
function editorFrom(content: DraftEditorContent): LexicalEditor {
	const editor = newEditor();
	editor.update(contentToEditor(content), { discrete: true });
	return editor;
}

/** A leaf of an editor, as the user sees it: text runs merged, pills and breaks kept apart. */
type Leaf =
	| { kind: "text"; text: string }
	| { kind: "mention"; text: string; id: string; type: string }
	| { kind: "break" }
	| { kind: "tab" };

/** The leaves of each paragraph of `editor`, adjacent text runs merged into one. */
function leaves(editor: LexicalEditor): Leaf[][] {
	return editor.getEditorState().read(() =>
		$getRoot()
			.getChildren()
			.map((paragraph) => {
				const out: Leaf[] = [];
				const children = $isElementNode(paragraph) ? paragraph.getChildren() : [];
				for (const node of children) {
					if ($isMentionNode(node)) {
						out.push({
							kind: "mention",
							text: node.getTextContent(),
							id: node.__mentionId,
							type: node.__mentionType,
						});
					} else if ($isLineBreakNode(node)) out.push({ kind: "break" });
					else if ($isTabNode(node)) out.push({ kind: "tab" });
					else {
						const last = out[out.length - 1];
						if (last?.kind === "text") last.text += node.getTextContent();
						else out.push({ kind: "text", text: node.getTextContent() });
					}
				}
				return out;
			}),
	);
}

/** The editor's own `getTextContent()` of the root, what the composer's send reads today. */
function rootText(editor: LexicalEditor): string {
	return editor.getEditorState().read(() => $getRoot().getTextContent());
}

describe("contentToEditor → editorToContent", () => {
	it("round-trips every valid content exactly (seeded, 1,000 cases)", () => {
		for (let seed = 1; seed <= 1_000; seed++) {
			const content = randomContent(rng(seed));
			// The generator only makes content the schema admits, so this is the codec's domain.
			expect(
				contentSchema.safeParse({ ...content, artifacts: [], cellTarget: null }).success,
				`seed ${seed}`,
			).toBe(true);
			const editor = editorFrom(content);
			expect(editorToContent(editor.getEditorState()), `seed ${seed}`).toEqual(content);
			expect(rootText(editor), `seed ${seed}`).toBe(content.text);
		}
	});

	it("keeps \\r\\n as \\r\\n, so a span after it stays on its pill", () => {
		const content: DraftEditorContent = {
			text: "a\r\nb @web",
			mentions: [{ id: "p1", type: "project", label: "web", start: 5, end: 9 }],
		};
		expect(editorToContent(editorFrom(content).getEditorState())).toEqual(content);
	});

	it("writes a pill per span, including two adjacent pills of the same resource", () => {
		const content: DraftEditorContent = {
			text: "@web@web",
			mentions: [
				{ id: "p1", type: "project", label: "web", start: 0, end: 4 },
				{ id: "p1", type: "project", label: "web", start: 4, end: 8 },
			],
		};
		const editor = editorFrom(content);
		expect(leaves(editor)).toEqual([
			[
				{ kind: "mention", text: "@web", id: "p1", type: "project" },
				{ kind: "mention", text: "@web", id: "p1", type: "project" },
			],
		]);
		expect(editorToContent(editor.getEditorState())).toEqual(content);
	});

	it("writes an empty draft as an empty editor", () => {
		const editor = editorFrom({ text: "", mentions: [] });
		expect(rootText(editor)).toBe("");
		expect(editorToContent(editor.getEditorState())).toEqual({ text: "", mentions: [] });
	});

	it("writes a span that does not fit the text as plain text, losing no words", () => {
		const content: DraftEditorContent = {
			text: "ask @web",
			mentions: [{ id: "p1", type: "project", label: "api", start: 4, end: 8 }],
		};
		const editor = editorFrom(content);
		expect(editorToContent(editor.getEditorState())).toEqual({ text: "ask @web", mentions: [] });
	});

	it("replaces what the editor held, and moves a live selection to the end", () => {
		const editor = editorFrom({ text: "old words", mentions: [] });
		editor.update(
			() => {
				$getRoot().selectStart();
				contentToEditor({ text: "new", mentions: [] })();
			},
			{ discrete: true },
		);
		expect(rootText(editor)).toBe("new");
	});

	it("round-trips the largest draft (R7's worst case) on the pinned Lexical", () => {
		const filler = "\u0001";
		const label = filler.repeat(MAX_DRAFT_MENTION_FIELD);
		const pill = `@${label}`;
		const mentions: DraftMention[] = Array.from({ length: MAX_DRAFT_MENTION_SPANS }, (_, i) => ({
			id: filler.repeat(MAX_DRAFT_MENTION_FIELD),
			type: "project",
			label,
			start: i * pill.length,
			end: (i + 1) * pill.length,
		}));
		const pills = pill.repeat(MAX_DRAFT_MENTION_SPANS);
		const content = { text: pills + filler.repeat(MAX_USER_MESSAGE_CHARS - pills.length), mentions };
		expect(editorToContent(editorFrom(content).getEditorState())).toEqual(content);
	});

	it("round-trips a 50,000-line paste", () => {
		const content = { text: "a\n".repeat(MAX_USER_MESSAGE_CHARS / 2), mentions: [] };
		expect(editorToContent(editorFrom(content).getEditorState())).toEqual(content);
	});
});

/**
 * A random editor of `paragraphs` paragraphs of text runs, breaks, tabs and pills. One paragraph
 * is the composer's shape (plain text turns Enter into a line break, never a paragraph).
 */
function randomEditor(next: () => number, paragraphs: number): LexicalEditor {
	const editor = newEditor();
	editor.update(
		() => {
			const root = $getRoot();
			root.clear();
			for (let p = 0; p < paragraphs; p++) {
				const paragraph = $createParagraphNode();
				const count = Math.floor(next() * 10);
				const nodes: LexicalNode[] = [];
				for (let i = 0; i < count; i++) {
					const roll = next();
					if (roll < 0.4) {
						const units = ["a", " ", "@", "\r", "\uD83D\uDE00", "中"];
						nodes.push($createTextNode(randomString(next, units, 1, 5)));
					} else if (roll < 0.55) nodes.push($createLineBreakNode());
					else if (roll < 0.65) nodes.push($createTabNode());
					else {
						const label = randomString(next, LABEL_UNITS, 1, 5);
						const type = pick(next, MENTION_TYPES);
						nodes.push($createMentionNode(`@${label}`, pick(next, IDS), type));
					}
				}
				paragraph.append(...nodes);
				root.append(paragraph);
			}
		},
		{ discrete: true },
	);
	return editor;
}

describe("editorToContent → contentToEditor", () => {
	it("rebuilds a composer's editor node for node, text runs merged (seeded, 1,000 cases)", () => {
		for (let seed = 1; seed <= 1_000; seed++) {
			const editor = randomEditor(rng(seed), 1);
			const read = editorToContent(editor.getEditorState());
			// The spans index the text the composer's send reads today.
			expect(read.text, `seed ${seed}`).toBe(rootText(editor));
			expect(spansAreValid(read), `seed ${seed}`).toBe(true);
			const rebuilt = editorFrom(read);
			expect(leaves(rebuilt), `seed ${seed}`).toEqual(leaves(editor));
			expect(editorToContent(rebuilt.getEditorState()), `seed ${seed}`).toEqual(read);
		}
	});

	it("reads any editor's own text, and its content is a fixed point (seeded, 500 cases of 2-3 paragraphs)", () => {
		for (let seed = 1; seed <= 500; seed++) {
			const next = rng(seed);
			const editor = randomEditor(next, 2 + Math.floor(next() * 2));
			const read = editorToContent(editor.getEditorState());
			expect(read.text, `seed ${seed}`).toBe(rootText(editor));
			expect(spansAreValid(read), `seed ${seed}`).toBe(true);
			expect(editorToContent(editorFrom(read).getEditorState()), `seed ${seed}`).toEqual(read);
		}
	});

	it("reads a pill whose text lacks the '@' as plain text, not as a span", () => {
		const editor = newEditor();
		editor.update(
			() => {
				const paragraph = $createParagraphNode();
				paragraph.append($createTextNode("hi "), $createMentionNode("web", "p1", "project"));
				$getRoot().clear().append(paragraph);
			},
			{ discrete: true },
		);
		expect(editorToContent(editor.getEditorState())).toEqual({ text: "hi web", mentions: [] });
	});

	it("separates paragraphs as getTextContent does, and offsets spans past them", () => {
		const editor = newEditor();
		editor.update(
			() => {
				const first = $createParagraphNode().append($createTextNode("one"));
				const second = $createParagraphNode().append($createMentionNode("@web", "p1", "project"));
				$getRoot().clear().append(first, second);
			},
			{ discrete: true },
		);
		expect(editorToContent(editor.getEditorState())).toEqual({
			text: "one\n\n@web",
			mentions: [{ id: "p1", type: "project", label: "web", start: 5, end: 9 }],
		});
	});
});
