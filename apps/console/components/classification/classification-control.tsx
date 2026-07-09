"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one-stop classification surface for a resource. Renders the read-only chips, and — only
// when `canEdit` is true — a picker to change them. `canEdit` MUST be the SAME edit-permission
// the host surface already uses to gate that resource (e.g. connectors' `canManage`, a
// project's edit grant): never show a picker the user would 403 on. Pass `initialAssignments`
// from a batched `assignmentsForKind` hydration so a list of N rows costs one query.

import { Tags } from "lucide-react";
import { Button } from "@repo/ui/button";
import { cn } from "@repo/ui/utils";
import type { ResourceKind } from "@/lib/db/schema/enums";
import type { AssignedValue } from "@/lib/queries/classification";
import { useCanEditClassification } from "@/lib/query/use-classification-query";
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
}: {
	kind: ResourceKind;
	id: string;
	canEdit: boolean;
	initialAssignments?: AssignedValue[];
	align?: "start" | "center" | "end";
	className?: string;
	compact?: boolean;
}) {
	// Show the picker only when the caller can edit THIS resource AND holds `org:edit` (the
	// server gate for assign/clear). The AND keeps a custom-role user who can edit the
	// resource but lacks `org:edit` from a picker that would 403.
	const { data: orgEdit = false } = useCanEditClassification();
	const showPicker = canEdit && orgEdit;

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
							aria-label="Classify"
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
