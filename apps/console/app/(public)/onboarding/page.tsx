// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getProOffer } from "@/app/server/actions/billing";
import { getPendingAcceptance } from "@/app/server/actions/legal";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import { AuthShell } from "@/components/auth/auth-shell";
import { OnboardingForm, type OnboardingTrial } from "@/components/auth/onboarding-form";
import {
	completeOnboarding,
	deduceBillingCountry,
	resolveOnboarding,
	suggestedPayerCapacity,
} from "@/lib/auth/onboarding";
import { getViewer } from "@/lib/auth/owner";
import { safeNext } from "@/lib/auth/safe-next";
import { isStripeConfigured } from "@/lib/billing/config";
import { getOrgBilling } from "@/lib/billing/queries";
import { OnboardingStatus } from "./onboarding-status";

interface OnboardingPageProps {
	searchParams: Promise<{ next?: string }>;
}

/**
 * The `next` this page was given, when it is a real destination: same-origin (`safeNext`) and not
 * this page itself — `/onboarding?next=/onboarding` would otherwise redirect to itself forever.
 */
function requestedDestination(next: string | undefined): string | null {
	const requested = safeNext(next);
	if (!requested) return null;
	const path = requested.split("?")[0] ?? "";
	return path === "/onboarding" || path.startsWith("/onboarding/") ? null : requested;
}

/** Whether the Pro trial can be started here, and the tile's reason when it cannot. */
async function trialFor(): Promise<OnboardingTrial> {
	if (!isStripeConfigured()) {
		return { kind: "unavailable", reason: "Hosted billing isn’t configured on this deployment." };
	}
	const offer = await getProOffer();
	if (offer.kind === "trial") return { kind: "available", days: offer.trialDays ?? 30 };
	return {
		kind: "unavailable",
		reason: "No trial is available for this account. Start on Hobby and upgrade from Billing at any time.",
	};
}

/**
 * Post-signup onboarding (WIZ-W6, #6929). WHERE SETUP STANDS IS DECIDED HERE, ON THE SERVER, before
 * anything renders (`resolveOnboarding`):
 *
 *  - finished before → the `next` it was given, else `/dashboard`;
 *  - not marked finished but the org already has a live plan (the trial started and the completion
 *    write was lost) → finished now, then the destination. The form is never shown again for it;
 *  - a payment still being confirmed, a state nobody could read, or an org that could not be
 *    provisioned → a card that says so, with a retry and the support address, and no form;
 *  - otherwise → the form, with every default it can work out filled in.
 *
 * The destination after the form is `/{slug}/~/new` unless a `next` was given.
 */
export default async function OnboardingPage({ searchParams }: OnboardingPageProps) {
	const viewer = await getViewer();
	if (!viewer) redirect("/login");

	const { next } = await searchParams;
	const requested = requestedDestination(next);
	const retryHref = requested ? `/onboarding?next=${encodeURIComponent(requested)}` : "/onboarding";

	const state = await resolveOnboarding(viewer.id);
	if (state.kind === "complete") redirect(requested ?? "/dashboard");
	if (state.kind === "settled") {
		await completeOnboarding(viewer.id);
		redirect(requested ?? `/${state.org.slug}/~/new`);
	}
	if (state.kind !== "not-started") {
		return <OnboardingStatus kind={state.kind} retryHref={retryHref} />;
	}
	const org = state.org;

	// The session is scoped to the org being set up here, on the server — the logo upload behind
	// "Customize" acts on the session's org. It used to be set from a mount effect in the form, racing
	// the upload and the trial (A-06). Idempotent: it writes the same value on every load.
	await setActiveOrganization(org.id);

	const h = await headers();
	const [trial, pending, billing] = await Promise.all([
		trialFor(),
		getPendingAcceptance(),
		getOrgBilling(org.id),
	]);
	// The request's country header and language are read, never stored or logged; the org's own
	// earlier declaration comes first, so a retry does not re-guess what the person already said.
	const country = deduceBillingCountry({
		declared: billing?.billingCountry,
		geoCountry: h.get("cf-ipcountry"),
		email: viewer.email,
		acceptLanguage: h.get("accept-language"),
	});

	return (
		<AuthShell cardWidth="fluid">
			<OnboardingForm
				org={org}
				viewerId={viewer.id}
				trial={trial}
				terms={pending.satisfied ? [] : pending.documents}
				country={country}
				capacity={suggestedPayerCapacity(viewer.email)}
				destination={requested}
			/>
		</AuthShell>
	);
}
