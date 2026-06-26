// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import { OnboardingWizard } from "@/components/auth/onboarding-wizard";
import { getOwner } from "@/lib/auth/owner";
import { getPrimaryOrg, isOnboardingComplete } from "@/lib/auth/onboarding";

interface OnboardingPageProps {
	searchParams: Promise<{ next?: string }>;
}

/**
 * Post-signup onboarding flow (organization → plan → invite → done). Gated: only
 * brand-new accounts (onboarding not yet complete) see it; everyone else is sent
 * straight to the console. Operates on the user's auto-provisioned primary org.
 */
export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
	const userId = await getOwner();
	if (!userId) redirect("/login");

	const { next } = await searchParams;
	const destination = next ?? "/dashboard";

	// Already onboarded → nothing to set up.
	if (await isOnboardingComplete(userId)) redirect(destination);

	// The primary org is provisioned at signup; if it's somehow missing, fall
	// through to the console rather than dead-ending here.
	const org = await getPrimaryOrg(userId);
	if (!org) redirect(destination);

	return (
		<AuthShell cardWidth="fluid">
			<OnboardingWizard org={org} />
		</AuthShell>
	);
}
