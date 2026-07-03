// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { env } from "next-runtime-env";

// The legal pages (terms / privacy / cookies / acceptable-use) are hosted-brand
// content served by the marketing app, not the console — so a self-hosted console
// build has no local legal routes. Links resolve against this base instead, defaulting
// to the canonical hosted site. On the stitched hosted deployment the marketing zone
// serves these at the same origin, so https://alethialabs.io/terms is correct there too;
// self-hosters can point NEXT_PUBLIC_LEGAL_URL at their own legal pages (or "" for
// same-origin if they run the marketing app behind their console domain).
const DEFAULT_LEGAL_BASE = "https://alethialabs.io";

/** Absolute URL for a legal page (e.g. "/terms"), honoring NEXT_PUBLIC_LEGAL_URL. */
export function legalUrl(path: `/${string}`): string {
	const base = env("NEXT_PUBLIC_LEGAL_URL") ?? DEFAULT_LEGAL_BASE;
	return `${base}${path}`;
}
