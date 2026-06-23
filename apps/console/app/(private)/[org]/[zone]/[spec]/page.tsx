// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { resolveSpecId, resolveZoneId } from "@/app/server/actions/resolve";
import { SpecDetailView } from "@/components/spec-detail/spec-detail-view";

/** `/{org}/{zone}/{spec}` — spec detail by slug (its default environment). */
export default async function SpecSlugPage({
	params,
}: {
	params: Promise<{ org: string; zone: string; spec: string }>;
}) {
	const { zone, spec } = await params;
	let zoneId: string;
	let specId: string;
	try {
		zoneId = await resolveZoneId(zone);
		specId = await resolveSpecId(zoneId, spec);
	} catch {
		notFound();
	}
	return <SpecDetailView zoneId={zoneId} specId={specId} />;
}
