// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { AuthCard, AuthShell } from "@/components/auth/auth-shell";
import { categoryLabel, readUnsubscribeToken } from "@/lib/email/preferences";

export const metadata: Metadata = { title: "Unsubscribe · Alethia" };
export const dynamic = "force-dynamic";

/**
 * The confirmation page an email's "Stop these alerts" / "Unsubscribe" link opens. It shows what
 * the link would stop and a button; the button POSTs to the same one-click endpoint a mail client's
 * own Unsubscribe button uses (`/api/email/unsubscribe`). Opening the page changes nothing.
 */
export default async function UnsubscribePage({
	searchParams,
}: {
	searchParams: Promise<{ t?: string; done?: string }>;
}) {
	const { t, done } = await searchParams;
	const claim = t ? readUnsubscribeToken(t) : null;
	if (!claim || !t) {
		return (
			<Card
				title="This link does not work"
				description="It may have been cut short when it was copied. Use the link in the email itself, or manage your email from your account."
			/>
		);
	}
	const what = categoryLabel(claim.category);
	if (done === "1") {
		return (
			<Card
				title="You are unsubscribed"
				description={`${what} will no longer be sent to ${claim.email}. Messages about your account, such as sign-in codes and receipts, are still sent.`}
			/>
		);
	}
	return (
		<Card
			title="Unsubscribe?"
			description={`Stop sending ${what.toLowerCase()} to ${claim.email}.`}
		>
			<form
				method="post"
				action={`/api/email/unsubscribe?t=${encodeURIComponent(t)}`}
				className="mt-6"
			>
				<input type="hidden" name="from" value="page" />
				<Button type="submit" className="w-full">
					Unsubscribe
				</Button>
			</form>
		</Card>
	);
}

/** The shared card for every state of the page. */
function Card({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children?: React.ReactNode;
}) {
	return (
		<AuthShell cardWidth="wide">
			<AuthCard>
				<SectionHeading title={title} description={description} />
				{children}
			</AuthCard>
		</AuthShell>
	);
}
