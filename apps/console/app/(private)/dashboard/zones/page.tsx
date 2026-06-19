// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getZones } from "@/app/server/actions/zones";
import { Button } from "@/components/ui/button";
import { Box, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

/** Redirects to the first zone, or shows empty state if none exist. */
export default async function ZonesPage() {
	const { zones } = await getZones();

	if (zones.length > 0) {
		redirect(`/dashboard/zones/${zones[0].id}`);
	}

	return (
		<div className="flex flex-col items-center justify-center py-16 text-center">
			<div className="p-3 bg-muted/50 rounded-full mb-4">
				<Box className="h-8 w-8 text-muted-foreground" />
			</div>
			<h3 className="text-sm font-medium text-foreground mb-1">
				No zones yet
			</h3>
			<p className="text-xs text-muted-foreground max-w-sm mb-4">
				Create your first spec to get started. A zone will
				be created automatically when you create a spec.
			</p>
			<Link href="/dashboard/design-spec">
				<Button size="sm" className="h-8 text-xs">
					<Plus className="h-3.5 w-3.5 mr-1.5" />
					Create a Spec
				</Button>
			</Link>
		</div>
	);
}
