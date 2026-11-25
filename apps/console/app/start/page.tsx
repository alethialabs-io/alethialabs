// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { redirect } from "next/navigation";
import { createCheckoutSession } from "@/app/server/actions/billing";
import { getActiveOrgSlug } from "@/app/server/actions/resolve";
import { AuthShell } from "@/components/auth/auth-shell";
import { isStripeConfigured } from "@/lib/billing/config";
import { PaidConversionNotAllowedError } from "@/lib/billing/eligibility";
import { salesProvider } from "@/lib/billing/provider/select";
import { getOwner } from "@/lib/auth/owner";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";

interface StartPageProps {
	searchParams: Promise<{ plan?: string; trial?: string }>;
}

/** This page's own address with the trial intent — where sign-in and the terms return to. */
const START_TRIAL_PATH ="/start?plan=team&trial=1";

/**
 * Intent carrier for the public "Start free trial" CTA. After sign-in the visitor lands
 * here with `?plan=team&trial=1`; we resolve their active org and drop them straight into
 * Stripe Checkout (Team's one-month trial). When billing isn't hosted (dev / self-managed)
 * or the checkout can't be created, we fall back to the org's billing settings surface so
 * the link is never a dead end. Unauthenticated hits bounce back through sign-in.
 *
 * A REFUSAL BY THE PAID-CONVERSION GATE IS SHOWN, NOT SWALLOWED (#5412). This page used to catch
 * every error from `createCheckoutSession` and redirect to billing, so a visitor the eligibility
 * gate refused — terms not accepted, payer not declared, a market not yet open — clicked "Start
 * free trial" and landed on the billing page with no word about why. The gate's sentence is the
 * one thing that says whether the answer is theirs to change, so it is rendered here, with the way
 * on to billing beside it. Every OTHER failure keeps the old fallback: those are about the
 * deployment or the scope (no org yet, Stripe unconfigured), and billing is where they resolve.
 *
 * The heading and the gate's sentence are read together, so they must not disagree (#5443): the
 * `market_closed` sentence once said "the Pro trial is unaffected" directly under "We can't start
 * your trial checkout", with no way to that trial from here. The sentence no longer makes a claim
 * about a trial; `tests/app/start-page.test.tsx` renders the gate's REAL refusal to pin that.
 *
 * ONE REFUSAL IS NOT SHOWN, BECAUSE THE VISITOR CAN ANSWER IT HERE: `terms_not_accepted`. This route
 * sits outside `(private)`, so the clickwrap gate never ran on the way in, and a brand-new account
 * always met it — a dead end whose only button led to billing, which bounced through
 * `/accept-terms` and lost the trial. It now goes to the terms with this page as `next`, so
 * accepting them comes straight back here and on to Checkout.
 */
export default async function StartPage({ searchParams }: StartPageProps) {
	// Only Team has a self-serve trial today; the param is reserved for future plans.
	await searchParams;

	const userId = await getOwner();
	if (!userId) {
		redirect(`/login?next=${encodeURIComponent(START_TRIAL_PATH)}`);
	}

	const slug = await getActiveOrgSlug();
	const billingHref = `/${slug}/~/settings/billing`;

	// Try to start hosted Checkout for the trial. createCheckoutSession throws on a
	// personal scope / missing permission / unconfigured Stripe — fall back to billing.
	let checkoutUrl: string | null = null;
	let refusal: string | null = null;
	let termsPending = false;
	// A Paddle instance has no hosted Checkout URL to send the visitor to: its trial is the card-less
	// local grant offered in the console, so the billing page (the fallback below) is where it starts.
	if (isStripeConfigured() && salesProvider() !== "paddle") {
		try {
			checkoutUrl = (await createCheckoutSession("team")).url;
		} catch (err) {
			// Called in-process from a server component, so the class survives — no server-action
			// boundary sits between this page and the gate to erase it.
			if (err instanceof PaidConversionNotAllowedError) {
				if (err.reason === "terms_not_accepted") termsPending = true;
				else refusal = err.message;
			}
			checkoutUrl = null;
		}
	}

	// redirect() throws internally, so it must run outside the try above.
	if (termsPending) {
		redirect(`/accept-terms?next=${encodeURIComponent(START_TRIAL_PATH)}`);
	}

	if (refusal) {
		return (
			<AuthShell>
				<EmptyState
					level={1}
					title="We can't start your trial checkout"
					description={refusal}
					action={
						<Button nativeButton={false} role="link" render={<Link href={billingHref} />}>
							Go to billing
						</Button>
					}
				/>
			</AuthShell>
		);
	}

	// redirect() throws internally, so it must run outside the try above.
	redirect(checkoutUrl ?? billingHref);
}
