// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getVineyards } from "@/app/server/actions/vineyards";
import { Button } from "@/components/ui/button";
import { Grape, Plus } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

/** Redirects to the first vineyard, or shows empty state if none exist. */
export default async function VineyardsPage() {
	const { vineyards } = await getVineyards();

	if (vineyards.length > 0) {
		redirect(`/dashboard/vineyards/${vineyards[0].id}`);
	}

	return (
		<div className="flex flex-col items-center justify-center py-16 text-center">
			<div className="p-3 bg-muted/50 rounded-full mb-4">
				<Grape className="h-8 w-8 text-muted-foreground" />
			</div>
			<h3 className="text-sm font-medium text-foreground mb-1">
				No vineyards yet
			</h3>
			<p className="text-xs text-muted-foreground max-w-sm mb-4">
				Create your first vine to get started. A vineyard will
				be created automatically when you plant a vine.
			</p>
			<Link href="/dashboard/plant">
				<Button size="sm" className="h-8 text-xs">
					<Plus className="h-3.5 w-3.5 mr-1.5" />
					Plant a Vine
				</Button>
			</Link>
		</div>
	);
}
