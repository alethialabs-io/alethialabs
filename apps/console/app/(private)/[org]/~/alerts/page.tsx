// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import {
	type AlertsBootstrap,
	getAlertChannelsPage,
	getAlertDeliveriesPage,
	getAlertPoliciesPage,
	getAlertsBootstrap,
} from "@/app/server/actions/alerts";
import { AlertsPage } from "@/components/alerts/alerts-page";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { ForbiddenError } from "@/lib/authz/types";
import { getQueryClient } from "@/lib/query/client";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Alerts",
	description: "Notification channels, alert rules, and delivery activity.",
});

/** Alerts surface: notification channels, alert rules, and the delivery activity log. */
export default async function AlertsRoute({
	params,
}: {
	params: Promise<{ org: string }>;
}) {
	const { org } = await params;
	let bootstrap: AlertsBootstrap;
	try {
		bootstrap = await getAlertsBootstrap();
	} catch (err) {
		if (err instanceof ForbiddenError) {
			return (
				<div className="p-6">
					<Alert>
						<AlertTitle>No access to alerts</AlertTitle>
						<AlertDescription>
							You don&apos;t have permission to view alerting for this organization.
							Ask an owner or admin for the <code>view_alerts</code> permission.
						</AlertDescription>
					</Alert>
				</div>
			);
		}
		throw err;
	}

	// The three filtered lists are TanStack queries now (#4890), so they are prefetched and
	// hydrated here rather than fetched after hydration — lib/query/README.md, step 2. The key
	// MUST be the pristine one the client builds on first render (`normalize*Query()` of the
	// default filters is `{}`), or hydration misses and the panel fetches anyway.
	//
	// Skipped entirely below the entitlement: that render is the upsell, no list is on screen,
	// and the client hooks are disabled there for the same reason.
	const queryClient = getQueryClient();
	if (bootstrap.alerting) {
		await Promise.all([
			queryClient.prefetchQuery({
				queryKey: qk.alertPolicies(org, {}),
				queryFn: () => getAlertPoliciesPage({}),
			}),
			queryClient.prefetchQuery({
				queryKey: qk.alertChannels(org, {}),
				queryFn: () => getAlertChannelsPage({}),
			}),
			queryClient.prefetchQuery({
				queryKey: qk.alertDeliveries(org, {}),
				queryFn: () => getAlertDeliveriesPage({}),
			}),
		]);
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<AlertsPage bootstrap={bootstrap} />
		</HydrationBoundary>
	);
}
