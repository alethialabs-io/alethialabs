// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SectionHeading } from "@repo/ui/section-heading";
import { AuthCard, AuthShell } from "@/components/auth/auth-shell";
import { EmailPreferencesForm } from "@/components/email/email-preferences-form";
import { auth } from "@/lib/auth";
import { OPTIONAL_EMAIL_CATEGORIES, optionalPreferences } from "@/lib/email/preferences";

export const metadata: Metadata = { title: "Email preferences · Alethia" };
export const dynamic = "force-dynamic";

/**
 * The signed-in person's optional email choices. Signed out, it sends them to sign in and back.
 * Messages about the account itself — sign-in codes, receipts, deletion notices — are not listed,
 * because they cannot be turned off.
 */
export default async function EmailPreferencesPage() {
	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) redirect(`/login?next=${encodeURIComponent("/email/preferences")}`);
	const current = await optionalPreferences(session.user.email);
	return (
		<AuthShell cardWidth="wide">
			<AuthCard>
				<SectionHeading
					title="Email preferences"
					description={`Optional email to ${session.user.email}. Messages about your account, such as sign-in codes, receipts and security notices, are always sent.`}
				/>
				<EmailPreferencesForm
					initial={current}
					productUpdatesDescription={OPTIONAL_EMAIL_CATEGORIES.product_updates.description}
				/>
			</AuthCard>
		</AuthShell>
	);
}
