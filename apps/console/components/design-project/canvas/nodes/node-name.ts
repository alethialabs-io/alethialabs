// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { BoardNode } from "@/lib/canvas/collections";
import { configName } from "../graph/node-config";
import { NODE_REGISTRY } from "../graph/node-registry";
import type { CanvasNodeData } from "../graph/types";

/**
 * The accessible name a canvas card carries — `"<kind> <name>"`.
 *
 * A card used to be an unnamed `<div>`. Two things follow from that, and both are why this exists
 * rather than a `data-testid`:
 *
 *  - the a11y audit scores what it can NAME. An unnamed node is not a low score, it is an absence,
 *    and an absence reads on a scoreboard exactly like a surface that was never rendered.
 *  - a test can only reach it through `.react-flow__node-<kind>`, a React Flow implementation
 *    class. That is a selector on the renderer, not on the product, and it cannot tell two buckets
 *    apart — which is precisely what a journey that adds two of something needs.
 *
 * The kind comes first because it is the stable half: a board always has a "Bucket …" even before
 * anything has been typed into it, so `getByRole("group", { name: /^Bucket/ })` is a usable query
 * on a freshly-added node. An empty name yields the kind alone rather than a trailing space — a
 * trailing space is invisible in a diff, and `getByRole`'s name matching normalises whitespace, so
 * an exact-name query against a stale `"Bucket "` would miss with nothing on screen to explain it.
 *
 * The one case that is NOT a concatenation: a card whose title has fallen back to its kind. The
 * card's own title is `configName(node.data) || def.label`, so an unnamed bucket is titled "Bucket"
 * and the naive join reads "Bucket Bucket" — measured, not imagined, the first time this ran. Same
 * word twice is not a name, and a user who genuinely types "Bucket" gets the same single word,
 * which is what the card shows them anyway.
 *
 * @param kind The card's kind word, exactly as the card's eyebrow prints it ("Bucket", "Database").
 * @param name The resource's own name, or "" when it has not been given one.
 * @returns The accessible name for the card's `aria-label`.
 */
export function nodeAccessibleName(kind: string, name: string): string {
	const k = kind.trim();
	const n = name.trim();
	if (!n || n === k) return k;
	return `${k} ${n}`;
}

/** The two words a card shows about itself: its kind line and its title. */
export interface CardIdentity {
	/** The kind as the card's eyebrow prints it. */
	eyebrow: string;
	/** The card's title: the resource's name, or its kind when it has none. */
	title: string;
}

/**
 * A design or out-of-band card's eyebrow and title, as the card prints them.
 *
 * An EXTERNAL card is one kind's worth of a bring-your-own IaC module, so it reads through the kind
 * its resources map to and is titled by the Terraform module they live in. A chart is titled by
 * its release id under the words "Helm chart". Every other card is its registry eyebrow and its
 * own name, falling back to the kind's label while it has none.
 */
export function cardIdentity(data: CanvasNodeData): CardIdentity {
	const def = NODE_REGISTRY[data.kind];
	if (data.kind === "external") {
		const mapped = data.config.mappedKind ? NODE_REGISTRY[data.config.mappedKind] : null;
		return {
			eyebrow: mapped?.eyebrow ?? def.eyebrow,
			title: data.config.module || "root module",
		};
	}
	if (data.kind === "chart") return { eyebrow: "Helm chart", title: data.config.id };
	return { eyebrow: def.eyebrow, title: configName(data) || def.label };
}

/**
 * The accessible name of any card the board draws — the name its focusable element carries.
 *
 * A collapsed collection has no name of its own: it stands for N resources, and the count is what
 * tells one board's vault from another's, so it is the plural title and the count.
 */
export function boardCardName(node: BoardNode): string {
	if (node.type === "collection") {
		const def = NODE_REGISTRY[node.data.kind];
		return nodeAccessibleName(
			def.collection?.title ?? def.label,
			String(node.data.memberIds.length),
		);
	}
	const { eyebrow, title } = cardIdentity(node.data);
	return nodeAccessibleName(eyebrow, title);
}

/** The id of the element that holds a card's spoken description (status, marks, connections). */
export function cardDescriptionId(nodeId: string): string {
	return `board-card-description-${nodeId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}
