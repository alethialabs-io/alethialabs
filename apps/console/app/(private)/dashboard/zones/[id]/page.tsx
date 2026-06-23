// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { getActiveOrgSlug, getZoneSlug } from "@/app/server/actions/resolve";
import { ZoneDetailView } from "@/components/zones/zone-detail-view";
import { zoneHref } from "@/lib/routing";

/** Legacy UUID zone route — canonicalizes to the slug URL `/{org}/{zone}`. Renders
 * the view directly only if the zone has no slug yet (defensive). */
export default async function ZoneUuidPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const slug = await getZoneSlug(id);
	if (slug) {
		const org = await getActiveOrgSlug();
		redirect(zoneHref(org, slug));
	}
	return <ZoneDetailView zoneId={id} />;
}
