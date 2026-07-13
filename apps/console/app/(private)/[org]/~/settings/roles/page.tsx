// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import {
	getRolesBootstrap,
	listRoles,
	type RolesBootstrap,
} from "@/app/server/actions/roles";
import { RolesManager } from "@/components/settings/roles/roles-manager";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { ForbiddenError } from "@/lib/authz/types";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Roles · Settings",
	description: "Built-in and custom roles for fine-grained access control.",
});

/**
 * Roles route. Prefetches the org's custom roles (server-side) into the query cache and
 * resolves the bootstrap (built-in roles, entitlement, manage permission) on the server, so
 * the manager renders with data on first paint. A viewer lacking `member:view` gets a notice.
 */
export default async function RolesPage({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;

	let bootstrap: RolesBootstrap;
	try {
		bootstrap = await getRolesBootstrap();
	} catch (err) {
		if (err instanceof ForbiddenError) {
			return (
				<div className="p-6">
					<Alert>
						<AlertTitle>No access to roles</AlertTitle>
						<AlertDescription>
							You don&apos;t have permission to view roles for this organization. Ask
							an owner or admin for access.
						</AlertDescription>
					</Alert>
				</div>
			);
		}
		throw err;
	}

	const queryClient = getQueryClient();
	await queryClient.prefetchQuery({
		queryKey: qk.roles(org),
		queryFn: () => listRoles(),
	});

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<RolesManager bootstrap={bootstrap} />
		</HydrationBoundary>
	);
}
