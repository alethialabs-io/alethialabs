// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Gauge } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveProjectId } from "@/app/server/actions/resolve";
import { globalHref } from "@/lib/routing";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Usage",
	description: "This project's resource usage.",
});

/**
 * `/{org}/{project}/usage` — placeholder until per-project usage rollups land. Usage is currently
 * aggregated at the org level, so this points at the org usage report for now. (Validates the
 * project slug so a bad URL still 404s rather than rendering a dangling page.)
 */
export default async function ProjectUsageRoute({
	params,
}: {
	params: Promise<{ org: string; project: string }>;
}) {
	const { org, project } = await params;
	try {
		await resolveProjectId(project);
	} catch {
		notFound();
	}

	return (
		<div className="flex flex-col items-center justify-center py-20 text-center">
			<div className="mb-4 rounded-full bg-muted/50 p-3">
				<Gauge className="h-8 w-8 text-muted-foreground" />
			</div>
			<h1 className="mb-1 text-sm font-medium text-foreground">
				Per-project usage is coming soon
			</h1>
			<p className="max-w-sm text-xs text-muted-foreground">
				Usage is currently reported across the whole organization. Per-project breakdowns
				will appear here once they land.
			</p>
			<Link
				href={globalHref(org, "usage")}
				className="mt-4 text-xs text-primary hover:underline"
			>
				View organization usage
			</Link>
		</div>
	);
}
