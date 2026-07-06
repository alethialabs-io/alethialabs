"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read-only classification chips for a resource. Renders one squared outline Badge per
// assigned value; a value's optional `color` shows as a small leading dot (the label stays
// grayscale to match the design system). Feed `assignments` for server-hydrated list rows
// (no per-row fetch), or omit it to lazily fetch via TanStack Query.

import { Badge } from "@repo/ui/badge";
import { cn } from "@repo/ui/utils";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { AssignedValue } from "@/lib/queries/classification";
import { useAssignmentsQuery } from "@/lib/query/use-classification-query";

/** One squared chip: an optional colour dot + the value label, prefixed by its dimension. */
function Chip({ chip }: { chip: AssignedValue }) {
	return (
		<Badge
			variant="outline"
			className="gap-1.5 font-normal text-muted-foreground"
			title={`${chip.dimension_label}: ${chip.value_label}`}
		>
			{chip.color ? (
				<span
					aria-hidden
					className="size-1.5 shrink-0 rounded-full"
					style={{ backgroundColor: chip.color }}
				/>
			) : null}
			<span className="text-foreground">{chip.value_label}</span>
		</Badge>
	);
}

/**
 * The chip row for a resource's classification assignments. Pass `assignments` to render a
 * batch-hydrated list (from `assignmentsForKind`) without a fetch; otherwise it fetches the
 * resource's chips itself. Renders nothing when there are no assignments.
 */
export function ClassificationChips({
	kind,
	id,
	assignments,
	className,
}: {
	kind: ResourceKind;
	id: string;
	assignments?: AssignedValue[];
	className?: string;
}) {
	const query = useAssignmentsQuery(kind, id, assignments === undefined);
	const chips = assignments ?? query.data ?? [];
	if (chips.length === 0) return null;

	return (
		<div className={cn("flex flex-wrap items-center gap-1", className)}>
			{chips.map((chip) => (
				<Chip key={chip.assignment_id} chip={chip} />
			))}
		</div>
	);
}
