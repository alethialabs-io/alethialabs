// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BRAND_BLACK, BRAND_INK } from "./ramp-srgb";

/**
 * The favicon's drawing as plain strings, with no `next/og` import, so a surface that is not a
 * Next app — the status Worker (`packages/status`) — serves the same icon the sites do instead of
 * a hand-copied one. `icon.tsx` builds its PNG from these constants, so the two cannot drift.
 */

/** The favicon's edge, in px. */
export const ICON_SIZE = 32;
/** Corner radius of the ink tile, in px. */
export const ICON_RADIUS = 7;
/** Rendered size of the mark inside the tile, in px; the tile centres it. */
export const ICON_MARK_SIZE = 25;

/** The bracketed-point mark, light on dark, as a standalone SVG document. */
export const ICON_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><path d="M11 6 H6.5 V26 H11" stroke="${BRAND_INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 6 H25.5 V26 H21" stroke="${BRAND_INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="16" r="2.9" fill="${BRAND_INK}"/></svg>`;

/**
 * The favicon as one SVG: the ink tile with the mark centred at `ICON_MARK_SIZE`, the vector twin
 * of the PNG `icon.tsx` renders. The mark is embedded as a nested `<svg>` so its geometry is the
 * `ICON_MARK_SVG` string itself, not a second transcription of it.
 */
export function faviconSvg(): string {
	const inset = (ICON_SIZE - ICON_MARK_SIZE) / 2;
	const mark = ICON_MARK_SVG.replace(
		"<svg ",
		`<svg x="${inset}" y="${inset}" width="${ICON_MARK_SIZE}" height="${ICON_MARK_SIZE}" `,
	);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ICON_SIZE} ${ICON_SIZE}" role="img" aria-label="Alethia Labs">` +
		`<rect width="${ICON_SIZE}" height="${ICON_SIZE}" rx="${ICON_RADIUS}" fill="${BRAND_BLACK}"/>` +
		mark +
		`</svg>`
	);
}
