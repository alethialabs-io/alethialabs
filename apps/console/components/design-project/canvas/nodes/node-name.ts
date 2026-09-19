// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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
