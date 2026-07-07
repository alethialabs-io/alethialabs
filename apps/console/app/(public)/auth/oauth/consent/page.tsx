// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Suspense } from "react";
import { AlethiaLogo } from "@repo/brand/alethia-logo";
import { OAuthConsentForm } from "@/components/forms/oauth-consent-form";

/**
 * OAuth consent screen (configured as the mcp() plugin's consentPage). Mirrors the
 * sign-in page chrome; the interactive decision lives in OAuthConsentForm (it reads
 * the consent_code/scope from the query, so it's wrapped in Suspense).
 */
export default function OAuthConsentPage() {
	return (
		<div className="relative min-h-screen bg-background">
			<div className="absolute top-10 left-10">
				<Link
					href="/"
					className="inline-flex items-center gap-2 hover:opacity-80 transition-opacity"
				>
					<AlethiaLogo withText className="h-6 w-auto text-foreground" />
				</Link>
			</div>

			<div className="min-h-screen flex items-center justify-center px-6">
				<div className="w-full max-w-[360px]">
					<Suspense>
						<OAuthConsentForm />
					</Suspense>
				</div>
			</div>
		</div>
	);
}
