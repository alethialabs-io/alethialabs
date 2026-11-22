// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import Link from "next/link";
import { formatDate } from "@repo/format";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { AuthCard, AuthShell } from "@/components/auth/auth-shell";
import { isLinkTokenShape } from "@/lib/privacy/link-token";
import { scheduledErasureByToken } from "@/lib/privacy/self-deletion";

export const metadata: Metadata = { title: "Account deletion · Alethia" };
export const dynamic = "force-dynamic";

/**
 * The page a scheduled-deletion email's "Keep my account" link opens. It SHOWS the deletion and
 * offers a button; only the button's POST (`/api/account/deletion/cancel`) cancels, so a mail
 * scanner that prefetches the link changes nothing. Reachable signed out: the person was signed out
 * when they scheduled the deletion, and signing in cancels it anyway.
 */
export default async function AccountDeletionPage({
	searchParams,
}: {
	searchParams: Promise<{ t?: string; result?: string }>;
}) {
	const { t, result } = await searchParams;

	if (result === "cancelled") {
		return (
			<Shell
				title="Your account will not be deleted"
				description="The deletion is cancelled and your account works as before. We have emailed you a confirmation. Sign in to continue."
				signIn
			/>
		);
	}
	const scheduled = t && isLinkTokenShape(t) ? await scheduledErasureByToken(t) : null;
	if (result === "invalid" || !scheduled || !t) {
		return (
			<Shell
				title="This link no longer works"
				description="The deletion it was for has already been cancelled, or has already run. Signing in to an account that is scheduled for deletion also cancels it."
				signIn
			/>
		);
	}
	return (
		<Shell
			title="Your account is scheduled for deletion"
			description={`Your Alethia account and the personal data tied to it will be deleted on ${formatDate(scheduled.scheduledFor, "date", "UTC")} (request ${scheduled.reference}). Keep your account to cancel the deletion.`}
		>
			<form method="post" action="/api/account/deletion/cancel" className="mt-6">
				<input type="hidden" name="t" value={t} />
				<Button type="submit" className="w-full">
					Keep my account
				</Button>
			</form>
		</Shell>
	);
}

/** The shared card for every state of the page. */
function Shell({
	title,
	description,
	signIn = false,
	children,
}: {
	title: string;
	description: string;
	signIn?: boolean;
	children?: React.ReactNode;
}) {
	return (
		<AuthShell cardWidth="wide">
			<AuthCard>
				<SectionHeading title={title} description={description} />
				{children}
				{signIn ? (
					<Button variant="outline" className="mt-6 w-full" render={<Link href="/login" />}>
						Sign in
					</Button>
				) : null}
			</AuthCard>
		</AuthShell>
	);
}
