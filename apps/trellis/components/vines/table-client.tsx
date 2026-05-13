"use client";

import { DataTable } from "@/components/data-table";
import { vinesColumns } from "@/components/vines/columns";
import { Button } from "@/components/ui/button";
import { PublicConfigurationsRow } from "@/lib/validations/db.schemas";
import { ArrowRight, FileText } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

interface VinesTableClientProps {
	configurations: PublicConfigurationsRow[];
}

export function VinesTableClient({ configurations }: VinesTableClientProps) {
	const router = useRouter();
	const searchParams = useSearchParams();
	const selectedConfigId = searchParams.get("config_id");

	const handleRowClick = useCallback(
		(row: PublicConfigurationsRow) => {
			router.push(`?config_id=${row.id}`, { scroll: false });
		},
		[router],
	);

	if (configurations.length === 0) {
		return (
			<div className="border border-dashed border-border/60 rounded-xl bg-muted/5 flex flex-col items-center justify-center py-20 text-center">
				<FileText className="h-10 w-10 text-muted-foreground mb-4 opacity-40" />
				<h3 className="text-base font-medium text-foreground mb-1">
					No vines planted yet
				</h3>
				<p className="text-sm text-muted-foreground mb-6 max-w-sm leading-relaxed">
					Plant your first infrastructure vine to see it here.
					You'll be able to quickly view, edit, and harvest it
					across your vineyards.
				</p>
				<Link href="/dashboard/configure">
					<Button
						size="sm"
						className="h-9 text-sm font-medium shadow-sm"
					>
						Plant a Vine
						<ArrowRight className="ml-2 h-4 w-4" />
					</Button>
				</Link>
			</div>
		);
	}

	return (
		<DataTable
			columns={vinesColumns}
			data={configurations}
			onRowClick={handleRowClick}
			selectedRowId={selectedConfigId ?? undefined}
		/>
	);
}
