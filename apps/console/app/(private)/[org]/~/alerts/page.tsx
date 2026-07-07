// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	type AlertsBootstrap,
	getAlertsBootstrap,
} from "@/app/server/actions/alerts";
import { AlertsPage } from "@/components/alerts/alerts-page";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { ForbiddenError } from "@/lib/authz/types";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Alerts",
	description: "Notification channels, alert rules, and delivery activity.",
});

/** Alerts surface: notification channels, alert rules, and the delivery activity log. */
export default async function AlertsRoute() {
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

	return <AlertsPage bootstrap={bootstrap} />;
}
