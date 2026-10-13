// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { AccessManager } from "@/components/settings/access/access-manager";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Access · Settings",
	description: "Access grants scoped to this project.",
});

/** `/{org}/{project}/settings/access` — Access grants scoped to this project. Resolves the project
 * slug → project id and hands it to the shared manager, which filters grants + fixes new-grant scope.
 * The `customRoles` entitlement is resolved here, on the server, so the first paint is the list (or
 * the upsell) rather than an upsell shown while the client store loads (#5850). */
export default async function ProjectAccessPage({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { project } = await params;
	let projectId: string;
	try {
		projectId = await resolveProjectId(project);
	} catch {
		notFound();
	}
	const { customRoles } = getEntitlements(await currentActor());
	return <AccessManager projectId={projectId} customRoles={customRoles} />;
}
