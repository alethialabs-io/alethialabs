"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Read-only classification chips for a resource. Renders one squared outline Badge per
// assigned value; a value's optional `color` shows as a small leading dot (the label stays
// grayscale to match the design system). Always query-backed (so a picker's optimistic
// mutation reflects instantly); pass `initialAssignments` from a batched `assignmentsForKind`
// hydration to seed the cache and avoid a per-row fetch.

import { Badge } from "@repo/ui/badge";
import { cn } from "@repo/ui/utils";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { AssignedValue } from "@/lib/queries/classification";
import { useAssignmentsQuery } from "@/lib/query/use-classification-query";

/** One squared chip: an optional colour dot + the value label. */
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
 * The chip row for a resource's classification assignments. `initialAssignments` seeds the
 * cache (batch-hydrated list rows) for an instant first paint; the row still stays reactive.
 * Renders nothing when there are no assignments.
 */
export function ClassificationChips({
	kind,
	id,
	initialAssignments,
	className,
}: {
	kind: ResourceKind;
	id: string;
	initialAssignments?: AssignedValue[];
	className?: string;
}) {
	const { data } = useAssignmentsQuery(kind, id, initialAssignments);
	const chips = data ?? [];
	if (chips.length === 0) return null;

	// A <span> container (not <div>) so chips are valid phrasing content inside a <button>
	// (e.g. the alerts rail rows).
	return (
		<span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
			{chips.map((chip) => (
				<Chip key={chip.assignment_id} chip={chip} />
			))}
		</span>
	);
}
