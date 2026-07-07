// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { createCheckoutSession } from "@/app/server/actions/billing";
import { getActiveOrgSlug } from "@/app/server/actions/resolve";
import { isStripeConfigured } from "@/lib/billing/config";
import { getOwner } from "@/lib/auth/owner";

interface StartPageProps {
	searchParams: Promise<{ plan?: string; trial?: string }>;
}

/**
 * Intent carrier for the public "Start free trial" CTA. After sign-in the visitor lands
 * here with `?plan=team&trial=1`; we resolve their active org and drop them straight into
 * Stripe Checkout (Team's one-month trial). When billing isn't hosted (dev / self-managed)
 * or the checkout can't be created, we fall back to the org's billing settings surface so
 * the link is never a dead end. Unauthenticated hits bounce back through sign-in.
 */
export default async function StartPage({ searchParams }: StartPageProps) {
	// Only Team has a self-serve trial today; the param is reserved for future plans.
	await searchParams;

	const userId = await getOwner();
	if (!userId) {
		redirect(
			`/login?next=${encodeURIComponent("/start?plan=team&trial=1")}`,
		);
	}

	const slug = await getActiveOrgSlug();
	const billingHref = `/${slug}/~/settings/billing`;

	// Try to start hosted Checkout for the trial. createCheckoutSession throws on a
	// personal scope / missing permission / unconfigured Stripe — fall back to billing.
	let checkoutUrl: string | null = null;
	if (isStripeConfigured()) {
		try {
			checkoutUrl = (await createCheckoutSession("team")).url;
		} catch {
			checkoutUrl = null;
		}
	}

	// redirect() throws internally, so it must run outside the try above.
	redirect(checkoutUrl ?? billingHref);
}
