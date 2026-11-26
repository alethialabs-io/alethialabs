// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AuthShell } from "@/components/auth/auth-shell";
import { ConsentSkeleton } from "@/components/auth/consent/consent-skeleton";

/**
 * /auth/oauth/consent while the route loads (SPEC §5b, case 22): the skeleton of the consent column.
 * Synchronous, as every `loading.tsx` must be.
 */
export default function OAuthConsentLoading() {
	return (
		<AuthShell cardWidth="wide">
			<ConsentSkeleton />
		</AuthShell>
	);
}
