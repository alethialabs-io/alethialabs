// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import {
	getSsoBootstrap,
	listSsoProviders,
	type SsoBootstrap,
} from "@/app/server/actions/sso";
import { SsoManager } from "@/components/settings/sso/sso-manager";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { ForbiddenError } from "@/lib/authz/types";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "SSO · Settings",
	description: "Single sign-on (SAML / OIDC) for your organization.",
});

/**
 * SSO route. Resolves the bootstrap (entitlement, manage permission, SP URLs) and prefetches the
 * provider list on the server. A viewer lacking `member:view` gets a no-access notice; the
 * Enterprise gate (no `sso` entitlement) is handled inside the manager (an upsell).
 */
export default async function SsoPage({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;

	let bootstrap: SsoBootstrap;
	try {
		bootstrap = await getSsoBootstrap();
	} catch (err) {
		if (err instanceof ForbiddenError) {
			return (
				<div className="p-6">
					<Alert>
						<AlertTitle>No access to SSO settings</AlertTitle>
						<AlertDescription>
							You don&apos;t have permission to view single sign-on for this
							organization. Ask an owner or admin for access.
						</AlertDescription>
					</Alert>
				</div>
			);
		}
		throw err;
	}

	const queryClient = getQueryClient();
	if (bootstrap.sso) {
		await queryClient.prefetchQuery({
			queryKey: qk.ssoProviders(org),
			queryFn: () => listSsoProviders(),
		});
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<SsoManager bootstrap={bootstrap} />
		</HydrationBoundary>
	);
}
