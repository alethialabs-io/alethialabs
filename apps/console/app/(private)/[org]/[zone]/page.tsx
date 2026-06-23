// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { resolveZoneId } from "@/app/server/actions/resolve";
import { ZoneDetailView } from "@/components/zones/zone-detail-view";

/** `/{org}/{zone}` — zone detail by slug. */
export default async function ZoneSlugPage({
	params,
}: {
	params: Promise<{ org: string; zone: string }>;
}) {
	const { zone } = await params;
	let zoneId: string;
	try {
		zoneId = await resolveZoneId(zone);
	} catch {
		notFound();
	}
	return <ZoneDetailView zoneId={zoneId} />;
}
