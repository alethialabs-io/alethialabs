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
 * trailing space is invisible in a diff and turns an exact-name query into a silent miss.
 *
 * @param kind The card's kind word, exactly as the card's eyebrow prints it ("Bucket", "Database").
 * @param name The resource's own name, or "" when it has not been given one.
 * @returns The accessible name for the card's `aria-label`.
 */
export function nodeAccessibleName(kind: string, name: string): string {
	const k = kind.trim();
	const n = name.trim();
	return n ? `${k} ${n}` : k;
}
