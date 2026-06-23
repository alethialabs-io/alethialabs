// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from "next/navigation";
import { getActiveOrgSlug, getSpecSlugPath } from "@/app/server/actions/resolve";
import { SpecDetailView } from "@/components/spec-detail/spec-detail-view";
import { specHref } from "@/lib/routing";

/** Legacy UUID spec route — canonicalizes to `/{org}/{zone}/{spec}`. Renders the
 * view directly only if the spec/zone has no slug yet (defensive). */
export default async function SpecUuidPage({
	params,
}: {
	params: Promise<{ id: string; specId: string }>;
}) {
	const { id, specId } = await params;
	const path = await getSpecSlugPath(specId);
	if (path) {
		const org = await getActiveOrgSlug();
		redirect(specHref(org, path.zoneSlug, path.specSlug));
	}
	return <SpecDetailView zoneId={id} specId={specId} />;
}
