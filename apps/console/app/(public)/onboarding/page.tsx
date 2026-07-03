// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { OnboardingForm } from "@/components/auth/onboarding-form";
import { getOwner } from "@/lib/auth/owner";
import { safeNext } from "@/lib/auth/safe-next";
import { getPrimaryOrg, isOnboardingComplete } from "@/lib/auth/onboarding";
import { getProOffer } from "@/app/server/actions/billing";
import { isStripeConfigured } from "@/lib/billing/config";

interface OnboardingPageProps {
	searchParams: Promise<{ next?: string }>;
}

/**
 * Post-signup onboarding: pick a plan + name the organization (everything else
 * optional). Gated — only brand-new accounts (onboarding not yet complete) see it;
 * everyone else is sent straight to the console. Operates on the user's
 * auto-provisioned primary organization, then drops into the in-product first-run.
 */
export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
	const userId = await getOwner();
	if (!userId) redirect("/login");

	const { next } = await searchParams;
	const destination = safeNext(next) ?? "/dashboard";

	// Already onboarded → nothing to set up.
	if (await isOnboardingComplete(userId)) redirect(destination);

	// The primary org is provisioned at signup; if it's somehow missing, fall
	// through to the console rather than dead-ending here.
	const org = await getPrimaryOrg(userId);
	if (!org) redirect(destination);

	// The account's Pro offer (one-time trial vs none) gates the trial CTA; Stripe being
	// configured gates the paid Pro path.
	const offer = await getProOffer();

	return (
		<AuthShell cardWidth="fluid">
			<OnboardingForm org={org} offer={offer} proAvailable={isStripeConfigured()} />
		</AuthShell>
	);
}
