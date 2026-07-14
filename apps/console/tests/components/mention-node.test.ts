// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// MentionNode is the atomic Discord-style pill: token mode (deletes as one unit), carries its
// resolved {id, type}, and round-trips through JSON so a persisted editor state rehydrates.

import { createEditor } from "lexical";
import { describe, expect, it } from "vitest";
import {
	$createMentionNode,
	$isMentionNode,
	MentionNode,
	type SerializedMentionNode,
} from "@/components/agent/elench/mention-node";

function withEditor(fn: () => void) {
	const editor = createEditor({
		namespace: "test",
		nodes: [MentionNode],
		onError: (e) => {
			throw e;
		},
	});
	editor.update(fn, { discrete: true });
}

describe("MentionNode", () => {
	it("is a token-mode pill carrying its {id, type} and @label text", () => {
		let snap: {
			isMention: boolean;
			mode: string;
			id: string;
			type: string;
			text: string;
		} | null = null;
		withEditor(() => {
			const node = $createMentionNode("@web", "c1", "cluster");
			snap = {
				isMention: $isMentionNode(node),
				mode: node.getMode(),
				id: node.__mentionId,
				type: node.__mentionType,
				text: node.getTextContent(),
			};
		});
		expect(snap).toEqual({
			isMention: true,
			mode: "token",
			id: "c1",
			type: "cluster",
			text: "@web",
		});
	});

	it("round-trips through export/import JSON", () => {
		let json: SerializedMentionNode | null = null;
		withEditor(() => {
			json = $createMentionNode("@api", "p1", "project").exportJSON();
		});
		expect(json).toMatchObject({
			type: "mention",
			text: "@api",
			mentionId: "p1",
			mentionType: "project",
		});

		let restored: { id: string; type: string; text: string } | null = null;
		withEditor(() => {
			// biome-ignore lint/style/noNonNullAssertion: json is set by the discrete update above.
			const node = MentionNode.importJSON(json!);
			restored = {
				id: node.__mentionId,
				type: node.__mentionType,
				text: node.getTextContent(),
			};
		});
		expect(restored).toEqual({ id: "p1", type: "project", text: "@api" });
	});
});
