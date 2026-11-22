// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LEGAL_ENTITY } from "@repo/legal/entity";
import { Button } from "@repo/ui/button";
import { AuthCard, AuthShell } from "@/components/auth/auth-shell";

/** The three states in which /onboarding shows a card instead of the form. */
export type OnboardingStatusKind = "no-org" | "unknown" | "in-flight";

/** What each card says: what happened, and what the person can do about it. */
const COPY: Record<OnboardingStatusKind, { eyebrow: string; heading: string; body: string; retry: string }> = {
	"no-org": {
		eyebrow: "Setup incomplete",
		heading: "We couldn't finish setting up your account",
		body: "Your sign-in worked, but we couldn't create your organization. This is on us, not you. Try again — if it keeps happening, write to support and we'll fix it from our side.",
		retry: "Try again",
	},
	unknown: {
		eyebrow: "Setup paused",
		heading: "We couldn't check your account",
		body: "Something on our side didn't answer, so we can't tell yet whether your organization is ready. Try again in a moment.",
		retry: "Try again",
	},
	"in-flight": {
		eyebrow: "Finishing your subscription",
		heading: "Your payment is still being confirmed",
		body: "Stripe hasn't confirmed this organization's payment yet, so this page won't start anything else. Check again in a minute — you'll go straight into the console once it's confirmed.",
		retry: "Check again",
	},
};

/**
 * The card /onboarding renders when the server says the form must not be shown (WIZ-W6, A-10): the
 * org could not be provisioned, its state could not be read, or a payment is unconfirmed. Every card
 * says what happened, offers a retry that re-asks the server (a plain reload of this address), and
 * names the support address. None of them offers a payment or a trial.
 */
export function OnboardingStatus({ kind, retryHref }: { kind: OnboardingStatusKind; retryHref: string }) {
	const copy = COPY[kind];
	const support = LEGAL_ENTITY.supportEmail;
	return (
		<AuthShell>
			<AuthCard>
				<div className="flex flex-col gap-2.5">
					<p className="vx-eyebrow">{copy.eyebrow}</p>
					<h1 className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary">
						{copy.heading}
					</h1>
					<p className="text-ui-lg leading-[1.55] text-text-secondary">{copy.body}</p>
				</div>
				<div className="mt-7 flex flex-col gap-3">
					<Button nativeButton={false} render={<a href={retryHref} />} className="h-[46px] w-full text-sm">
						{copy.retry}
					</Button>
					<p className="text-center text-ui-sm text-text-tertiary">
						Still stuck?{" "}
						<a
							href={`mailto:${support}`}
							className="underline underline-offset-4 hover:text-text-primary focus-visible:text-text-primary"
						>
							{support}
						</a>
					</p>
				</div>
			</AuthCard>
		</AuthShell>
	);
}
