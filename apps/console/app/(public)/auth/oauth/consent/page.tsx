// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { AuthShell } from "@/components/auth/auth-shell";
import type { ConsentView } from "@/components/auth/consent/consent-model";
import { signedOAuthQuery } from "@/components/auth/consent/consent-model";
import { ConsentScreen } from "@/components/auth/consent/consent-screen";
import { readConsentContext } from "@/lib/agents/consent-context";
import { getViewer } from "@/lib/auth/owner";
import { roleDisplayName } from "@/lib/authz/registry";

/** The consent screen reads the session and the signed request on every request. */
export const dynamic = "force-dynamic";

interface OAuthConsentPageProps {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The OAuth consent screen (AGT-L2, SPEC §5b), configured as the `mcp()` provider's `consentPage`.
 * Better Auth sends the person here with a signed copy of the authorization request; this page reads
 * what the screen shows for the signed-in person (`readConsentContext` — it grants nothing) and hands
 * it to the screen, whose Allow and Deny call `answerAgentConsent`.
 *
 * Nobody signed in (a session that lapsed between the authorize step and this page): sign in first and
 * come straight back to the same request.
 */
export default async function OAuthConsentPage({ searchParams }: OAuthConsentPageProps) {
	const oauthQuery = signedOAuthQuery(await searchParams);
	const viewer = await getViewer();
	if (!viewer) {
		const back = oauthQuery ? `/auth/oauth/consent?${oauthQuery}` : "/auth/oauth/consent";
		redirect(`/login?next=${encodeURIComponent(back)}`);
	}
	const context = await readConsentContext(viewer.id, oauthQuery);
	const view: ConsentView =
		context.state === "ready"
			? { ...context, orgs: context.orgs.map((o) => ({ ...o, roleLabel: roleDisplayName(o.role) })) }
			: context;
	return (
		<AuthShell cardWidth="wide">
			<ConsentScreen
				view={view}
				account={{ name: viewer.name, email: viewer.email, image: viewer.image }}
				oauthQuery={oauthQuery}
			/>
		</AuthShell>
	);
}
