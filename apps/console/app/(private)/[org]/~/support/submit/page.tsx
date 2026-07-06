// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { headers } from "next/headers";
import { SubmitCaseForm } from "@/components/support/submit/submit-case-form";
import { auth } from "@/lib/auth";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Submit a case · Support",
	description:
		"Open a new Alethia support case — pick the type, area, and severity, then describe the issue.",
});

/**
 * The new-case route. Prefills the notification email from the signed-in user's session
 * and renders the multi-step {@link SubmitCaseForm}, which submits + redirects to the case
 * thread on completion.
 */
export default async function SubmitCasePage({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	const session = await auth.api.getSession({ headers: await headers() });

	return (
		<div className="max-w-2xl">
			<SubmitCaseForm orgSlug={org} defaultEmail={session?.user?.email} />
		</div>
	);
}
