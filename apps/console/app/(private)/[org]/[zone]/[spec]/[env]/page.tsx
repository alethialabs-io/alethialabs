// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { resolveSpecId, resolveZoneId } from "@/app/server/actions/resolve";
import { SpecDetailView } from "@/components/spec-detail/spec-detail-view";

/** `/{org}/{zone}/{spec}/{env}` — spec detail focused on a specific environment. */
export default async function SpecEnvSlugPage({
	params,
}: {
	params: Promise<{ org: string; zone: string; spec: string; env: string }>;
}) {
	const { zone, spec, env } = await params;
	let zoneId: string;
	let specId: string;
	try {
		zoneId = await resolveZoneId(zone);
		specId = await resolveSpecId(zoneId, spec);
	} catch {
		notFound();
	}
	return <SpecDetailView zoneId={zoneId} specId={specId} envName={env} />;
}
