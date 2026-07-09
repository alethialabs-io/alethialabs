"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Popover to set/clear a resource's classification values. One section per dimension:
// single-valued dimensions behave like a radio (picking a value swaps the prior one;
// picking the selected value clears it), multi-valued like checkboxes. Writes through the
// server actions with optimistic TanStack Query updates (see use-classification-query).

import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@repo/ui/popover";
import { cn } from "@repo/ui/utils";
import { Check, Tags } from "lucide-react";
import type { ReactNode } from "react";
import type { DimensionDTO } from "@/app/server/actions/classification/dimensions";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { AssignedValue } from "@/lib/queries/classification";
import {
	useAssignmentMutations,
	useAssignmentsQuery,
	useDimensionsQuery,
} from "@/lib/query/use-classification-query";

/** A single selectable value row inside a dimension section. */
function ValueRow({
	label,
	color,
	selected,
	onSelect,
}: {
	label: string;
	color: string | null;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted/60",
				selected ? "text-foreground" : "text-muted-foreground",
			)}
		>
			<Check
				className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")}
			/>
			{color ? (
				<span
					aria-hidden
					className="size-1.5 shrink-0 rounded-full"
					style={{ backgroundColor: color }}
				/>
			) : null}
			<span className="truncate">{label}</span>
		</button>
	);
}

/**
 * The classification picker. Renders a trigger (default: a subtle "Classify" button) that
 * opens a popover of the org's dimensions; toggling a value assigns/clears it on the
 * resource. Falls back to a management hint when the org has no dimensions yet.
 */
export function ClassificationPicker({
	kind,
	id,
	trigger,
	align = "start",
	initialAssignments,
}: {
	kind: ResourceKind;
	id: string;
	trigger?: ReactNode;
	align?: "start" | "center" | "end";
	initialAssignments?: AssignedValue[];
}) {
	const dimensionsQuery = useDimensionsQuery();
	const assignmentsQuery = useAssignmentsQuery(kind, id, initialAssignments);
	const dimensions = dimensionsQuery.data ?? [];
	const { assign, unassign } = useAssignmentMutations(kind, id, dimensions);

	const selectedValueIds = new Set(
		(assignmentsQuery.data ?? []).map((a) => a.value_id),
	);

	/** Toggles a value: clears it if already set, else assigns (single-valued swaps). */
	function toggle(dimension: DimensionDTO, valueId: string) {
		if (selectedValueIds.has(valueId)) {
			unassign.mutate(valueId);
		} else {
			assign.mutate(valueId);
		}
	}

	return (
		<Popover>
			<PopoverTrigger asChild>
				{trigger ?? (
					<Button variant="outline" size="sm" className="gap-1.5">
						<Tags className="size-3.5" />
						Classify
					</Button>
				)}
			</PopoverTrigger>
			<PopoverContent align={align} className="w-64 p-0">
				<div className="max-h-80 overflow-y-auto">
					{dimensions.length === 0 ? (
						<p className="px-3 py-4 text-sm text-muted-foreground">
							No classification dimensions yet. An admin can create them in
							Settings → Classification.
						</p>
					) : (
						dimensions.map((dimension) => (
							<div
								key={dimension.id}
								className="border-b border-border/60 py-1.5 last:border-b-0"
							>
								<div className="flex items-center justify-between px-2 pb-1">
									<span className="text-xs font-medium text-foreground">
										{dimension.label}
									</span>
									<Badge
										variant="outline"
										className="h-4 px-1 text-[10px] font-normal text-muted-foreground"
									>
										{dimension.multi ? "multi" : "single"}
									</Badge>
								</div>
								{dimension.values.length === 0 ? (
									<p className="px-2 py-1 text-xs text-muted-foreground">
										No values defined.
									</p>
								) : (
									dimension.values.map((value) => (
										<ValueRow
											key={value.id}
											label={value.label}
											color={value.color}
											selected={selectedValueIds.has(value.id)}
											onSelect={() => toggle(dimension, value.id)}
										/>
									))
								)}
							</div>
						))
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
