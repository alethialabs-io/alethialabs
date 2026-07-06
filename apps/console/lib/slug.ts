// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single source of truth for turning a free-text name (org / project / environment)
// into a URL slug, Vercel-style: fold accents, drop apostrophes, hyphenate the rest. So
// "bobikenobi12's Org" → "bobikenobi12s-org" and "José's Café" → "joses-cafe" (rather than
// leaking a stray "-s-" segment for every apostrophe). Everywhere a slug is derived imports
// from here — keep it dependency-free so server actions, route handlers and client
// components can all share it.

/** Unicode combining diacritical marks — what NFKD splits an accented letter into. */
const COMBINING_MARKS = /[\u0300-\u036f]/g;
/** Apostrophes / quotes that should vanish rather than become a dash (`bob's` → `bobs`). */
const APOSTROPHES = /['\u2019\u02bc`]+/g;

/**
 * Normalizes a free-text name into a URL slug (`[a-z0-9]` + single dashes; "" → "").
 * Folds accents (`José` → `jose`) and drops apostrophes (`bob's` → `bobs`) before
 * hyphenating any remaining non-alphanumeric runs. Pass `maxLength` to cap the result
 * (re-trimming a trailing dash the cut may expose).
 */
export function slugify(raw: string, maxLength?: number): string {
	const s = raw
		.normalize("NFKD") // split accented letters into base char + combining mark
		.replace(COMBINING_MARKS, "") // strip the marks: José → Jose
		.toLowerCase()
		.replace(APOSTROPHES, "") // bob's → bobs (not bob-s)
		.replace(/[^a-z0-9]+/g, "-") // any other non-alphanumeric run → a single dash
		.replace(/^-+|-+$/g, ""); // trim leading/trailing dashes
	return maxLength ? s.slice(0, maxLength).replace(/-+$/g, "") : s;
}
