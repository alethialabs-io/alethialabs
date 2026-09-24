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
import { alertsQueriesFromUrl } from "@/components/alerts/alerts-query";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { ForbiddenError } from "@/lib/authz/types";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { qk } from "@/lib/query/keys";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Alerts",
	description: "Notification channels, alert rules, and delivery activity.",
});

/** Alerts surface: notification channels, alert rules, and the delivery activity log. */
export default async function AlertsRoute({
	params,
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
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
	// A pasted FILTERED link (`?policyStatus=off`) also gets each panel's filtered list prefetched
	// (#4980, the audit's F8). The client renders pristine first — `useFilterUrlSync` reads the URL
	// in a mount effect — and then asks for the filtered key; without this that key arrived empty
	// and `keepPreviousData` held the unfiltered rows up until the server action returned. These
	// are the server's own filtered reads through the builders the hooks call, not a client-side
	// selection like `~/connectors`' seed (#4968), so they are as fresh as the pristine lists. For
	// a pristine link the filtered key IS `{}`, and TanStack dedupes it against the pristine fetch.
	//
	// Skipped entirely below the entitlement: that render is the upsell, no list is on screen,
	// and the client hooks are disabled there for the same reason.
	const queryClient = getQueryClient();
	if (bootstrap.alerting) {
		const filtered = alertsQueriesFromUrl(paramReader(await searchParams));
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
			queryClient.prefetchQuery({
				queryKey: qk.alertPolicies(org, filtered.policies),
				queryFn: () => getAlertPoliciesPage(filtered.policies),
			}),
			queryClient.prefetchQuery({
				queryKey: qk.alertChannels(org, filtered.channels),
				queryFn: () => getAlertChannelsPage(filtered.channels),
			}),
			queryClient.prefetchQuery({
				queryKey: qk.alertDeliveries(org, filtered.activity),
				queryFn: () => getAlertDeliveriesPage(filtered.activity),
			}),
		]);
	}

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			<AlertsPage bootstrap={bootstrap} />
		</HydrationBoundary>
	);
}
