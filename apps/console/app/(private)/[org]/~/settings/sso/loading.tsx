// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PeopleUpsellSkeleton } from "@/components/settings/members/people-skeleton";
import { PanelSkeleton } from "@/components/skeletons/page-skeletons";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton for the settings/sso route (#6132, F021). With the `sso` entitlement it is the
 * manager's shape: the toolbar (count, one line, Connect provider), the filter bar (search,
 * Protocol, Status), then the provider panel. Without it the page's whole body is the upsell, so
 * the skeleton is the upsell's box alone — not a toolbar and a list that never arrive. The
 * entitlement is the one `page.tsx` decides on, from the same request-cached actor.
 */
export default async function SsoLoading() {
	const { sso } = getEntitlements(await currentActor());
	if (!sso) return <PeopleUpsellSkeleton toolbar={false} />;
	return (
		<div aria-busy>
			<PageToolbarSkeleton className="mb-4" count actions={1} />
			<div aria-hidden className="mb-4 flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-8 w-[240px] max-w-[380px] flex-1 rounded-md" />
				<Skeleton className="h-8 w-28 rounded-md" />
				<Skeleton className="h-8 w-28 rounded-md" />
			</div>
			<PanelSkeleton lines={5} />
		</div>
	);
}
