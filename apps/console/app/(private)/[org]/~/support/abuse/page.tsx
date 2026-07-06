// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { AbuseForm } from "@/components/support/abuse/abuse-form";
import { auth } from "@/lib/auth";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Report abuse · Support",
	description:
		"Report phishing, malware, spam, copyright, or other policy violations to Alethia's trust & safety team.",
});

/**
 * The abuse-report route. Prefills the notification email from the signed-in user's session
 * and renders the {@link AbuseForm}, which submits + redirects to the case thread.
 */
export default async function ReportAbusePage({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const session = await auth.api.getSession({ headers: await headers() });

	return <AbuseForm orgSlug={org} defaultEmail={session?.user?.email} />;
}
