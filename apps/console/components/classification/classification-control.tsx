"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one-stop classification surface for a resource. Renders the read-only chips, and — only
// when `canEdit` is true — a picker to change them. `canEdit` MUST be the SAME edit-permission
// the host surface already uses to gate that resource (e.g. connectors' `canManage`, a
// project's edit grant): never show a picker the user would 403 on. Pass `initialAssignments`
// from a batched `assignmentsForKind` hydration so a list of N rows costs one query.
//
// FIRST PAINT AND FAILURE (#6334). A route that renders this control prefetches its reads on the
// server (`prefetch-classification.ts`), so the picker is in the first paint rather than arriving
// after a client read. When a read this control depends on FAILS with nothing to show, it renders
// `RegionError` with a retry in its place — never nothing: a picker or chips that silently vanish
// read as "you may not classify this" / "nothing is classified", which is false.

import { Tags } from "lucide-react";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { AssignedValue } from "@/lib/queries/classification";
import { RegionError } from "@/components/errors/region-error";
import {
	useAssignmentsQuery,
	useCanEditClassification,
} from "@/lib/query/use-classification-query";
import { readRefusalOf } from "@/lib/rpc/refusal";
import { ClassificationChips } from "./classification-chips";
import { ClassificationPicker } from "./classification-picker";

export function ClassificationControl({
	kind,
	id,
	canEdit,
	initialAssignments,
	align = "start",
	className,
	/** Compact icon-only picker trigger (for dense list rows). */
	compact = false,
	/**
	 * Names the compact trigger's row for a caller that renders several `ClassificationControl`s
	 * on one screen (e.g. a per-account or per-runner list) — the accessible name becomes
	 * `Classify ${label}` instead of the bare "Classify" every row would otherwise share.
	 * Optional and additive: every existing `compact` call site keeps the bare "Classify" name
	 * unchanged.
	 */
	label,
}: {
	kind: ResourceKind;
	id: string;
	canEdit: boolean;
	initialAssignments?: AssignedValue[];
	align?: "start" | "center" | "end";
	className?: string;
	compact?: boolean;
	label?: string;
}) {
	// Show the picker only when the caller can edit THIS resource AND holds `org:edit` (the
	// server gate for assign/clear). The AND keeps a custom-role user who can edit the
	// resource but lacks `org:edit` from a picker that would 403.
	const permission = useCanEditClassification();
	// The same key the chips and the picker read (one request): read here only to see it FAIL.
	const assignments = useAssignmentsQuery(kind, id, initialAssignments);
	const showPicker = canEdit && permission.data === true;

	// A failed read with nothing cached is an error, not an absence. The permission read only
	// matters where the caller could edit; an expected refusal of the chips (a viewer the org
	// read refuses) is not a failure and keeps the chip-less render.
	const permissionFailed = canEdit && permission.isError && permission.data === undefined;
	const chipsFailed =
		assignments.isError &&
		assignments.data === undefined &&
		readRefusalOf(assignments.error) === null;
	if (permissionFailed || chipsFailed) {
		return (
			<RegionError
				title="Couldn't load classification"
				description="Something went wrong loading this resource's classification."
				className={cn("p-3 md:p-3", className)}
				onRetry={() => {
					if (permissionFailed) void permission.refetch();
					if (chipsFailed) void assignments.refetch();
				}}
			/>
		);
	}

	if (!showPicker) {
		return (
			<ClassificationChips
				kind={kind}
				id={id}
				initialAssignments={initialAssignments}
				className={className}
			/>
		);
	}

	return (
		<div className={cn("flex flex-wrap items-center gap-1.5", className)}>
			<ClassificationChips
				kind={kind}
				id={id}
				initialAssignments={initialAssignments}
			/>
			<ClassificationPicker
				kind={kind}
				id={id}
				align={align}
				initialAssignments={initialAssignments}
				trigger={
					compact ? (
						<Button
							variant="ghost"
							size="icon"
							aria-label={label ? `Classify ${label}` : "Classify"}
							className="size-6 text-muted-foreground"
						>
							<Tags className="size-3.5" />
						</Button>
					) : undefined
				}
			/>
		</div>
	);
}
