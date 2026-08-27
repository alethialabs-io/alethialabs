// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One percentage for the Usage card's two renderers.
//
// The ring (usage-ring.tsx) and the "% used" caption (usage-card.tsx) each computed their own
// percentage from the same pair, and they did not agree: the caption used an UNCLAMPED
// `Math.round((used / limit) * 100)`, the ring a CLAMPED `Math.round(Math.min(used / limit, 1) * 100)`,
// and each derived its own near-limit flag from its own number — so 84.6% read "85% used" beside a
// ring drawn (and weighted) as 84%. Both now call these.

/**
 * Fraction of an allowance consumed.
 *
 * Deliberately UNCLAMPED: an org 25% over its included minutes should be able to say so. The ring
 * clamps for its own arc, because a circle cannot draw more than a full turn — that clamp belongs
 * to the drawing, not to the number.
 *
 * @param used amount consumed; may be fractional. Negative is clamped to 0.
 * @param limit the allowance. 0 or negative yields 0 — an uncapped row has no meaningful percent.
 */
export function usageRatio(used: number, limit: number): number {
	if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
	return Math.max(used, 0) / limit;
}

/** At or above this fraction of the allowance, the card reads as near-limit (heavier ink). */
export const NEAR_LIMIT_RATIO = 0.85;

/**
 * The percentage a gauge shows, as text and without the `%` sign — `0`, `<1`, `47`, `125`.
 *
 * `<1` exists for the same reason `formatMinutes` has `<1 min`: the org overview rendered
 * 0.943 minutes of a 200-minute allowance as "0% used", which reads as "nothing has run" when
 * something has. `0` is reserved for a genuinely unused allowance, so the two states stay
 * distinguishable — and the caption then agrees with the readout beside it rather than pairing
 * "0% used" with "<1 min".
 */
export function formatUsagePercent(used: number, limit: number): string {
	const pct = usageRatio(used, limit) * 100;
	if (pct <= 0) return "0";
	if (pct < 1) return "<1";
	return String(Math.round(pct));
}
