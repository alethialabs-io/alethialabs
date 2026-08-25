// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type React from "react";
import { getOwner } from "@/lib/auth/owner";
import { hasAcceptedCurrentDocuments } from "@/lib/billing/eligibility";

// Every route under (private) is behind authentication — crawlers only ever reach a login
// redirect, so the whole group is marked noindex. Per-page titles + OpenGraph still apply
// (Next merges metadata down the tree; pages never set `robots`, so they inherit this), which
// keeps internal link unfurls working without exposing the app to search indexing.
export const metadata: Metadata = {
	robots: { index: false, follow: false },
};

/**
 * The route the acceptance gate sends people to. Inside (private) — it needs the session — and
 * therefore EXCLUDED from the gate itself, or the redirect loops forever.
 */
const ACCEPTANCE_ROUTE = "/accept-terms";

export default async function PrivateLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	// The clickwrap gate: no use of the product before the current Terms are accepted (#2372).
	//
	// It lives HERE, in the layout every private route renders through, rather than being added to
	// each entry point. "Before first use" is a property of the whole app, and a per-route check is
	// a list that the next route forgets to join — which is how a gate ends up covering the dashboard
	// and not the thing someone linked to directly.
	//
	// It is deliberately NOT in middleware: middleware runs on the edge with no database, so the
	// only thing it could check is a cookie — and a cookie asserting "terms accepted" is a claim by
	// the client about a legal fact, which is exactly what must not be trusted here.
	//
	// Unauthenticated requests fall through untouched; the page-level guards already redirect those
	// to /login, and duplicating that here would race them.
	const userId = await getOwner();
	if (userId && !(await hasAcceptedCurrentDocuments(userId))) {
		redirect(ACCEPTANCE_ROUTE);
	}
	return children;
}
