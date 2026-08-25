// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { AcceptTermsForm } from "@/components/legal/accept-terms-form";
import { getPendingAcceptance } from "@/app/server/actions/legal";
import { getOwner } from "@/lib/auth/owner";
import { safeNext } from "@/lib/auth/safe-next";

interface AcceptTermsPageProps {
	searchParams: Promise<{ next?: string }>;
}

/**
 * The post-auth clickwrap (#2372).
 *
 * It lives under `(public)` and does its own session check, exactly as `/onboarding` does — NOT
 * under `(private)`, whose layout carries the gate that sends people here. A gated route inside the
 * gate is an infinite redirect.
 *
 * It shows on first sign-in and again whenever a document reaches a new version, because a new
 * version is a new agreement. A user who accepted v1 has not agreed to v2, and carrying the old row
 * forward would be inventing consent — the same rule #2371 applied when it refused to migrate a v1
 * consent cookie into v2.
 */
export default async function AcceptTermsPage({
	searchParams,
}: AcceptTermsPageProps) {
	const userId = await getOwner();
	if (!userId) redirect("/login");

	// Where to go after accepting. The gate in (private)/layout.tsx cannot pass one — a Next layout
	// does not receive the pathname — so the default is `/dashboard`, whose catch-all canonicalizes
	// to the user's org (and handles the no-org and not-yet-onboarded cases on the way). The cost is
	// that a RE-acceptance loses a deep link: an existing user who followed a URL lands on their
	// dashboard rather than that URL. That is a wrinkle, not a defect — and the alternatives (an
	// internal Next header, or reading Referer) are guesses about framework internals, which is a
	// worse trade for a redirect that runs once per Terms version.
	const { next } = await searchParams;
	const destination = safeNext(next) ?? "/dashboard";

	const pending = await getPendingAcceptance();
	// Nothing outstanding — never strand someone on a page with nothing to do.
	if (pending.satisfied) redirect(destination);

	return (
		<AuthShell>
			<AcceptTermsForm documents={pending.documents} next={destination} />
		</AuthShell>
	);
}
