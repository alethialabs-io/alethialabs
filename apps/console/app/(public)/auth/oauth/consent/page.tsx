// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Suspense } from "react";
import { AuthShell } from "@/components/auth/auth-shell";
import { OAuthConsentForm } from "@/components/forms/oauth-consent-form";

/**
 * OAuth consent screen (configured as the mcp() plugin's consentPage). It used to
 * MIRROR the sign-in chrome by hand — its own logo at `top-10 left-10` against the
 * shell's `px-8 py-6`, and no footer at all. It wears the real shell now; the
 * interactive decision lives in OAuthConsentForm (it reads the consent_code/scope
 * from the query, so it stays wrapped in Suspense).
 */
export default function OAuthConsentPage() {
	return (
		<AuthShell>
			<Suspense>
				<OAuthConsentForm />
			</Suspense>
		</AuthShell>
	);
}
