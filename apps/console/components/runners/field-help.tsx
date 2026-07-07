"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Small form-field helpers shared by the runner/pool creation sheets: a label row with an
// optional required mark + inline help popover. The popover itself is the shared design-system
// `@repo/ui/field-help`; `FieldHelp` here keeps the `description` (string) signature these sheets use.

import { FieldHelp as UiFieldHelp } from "@repo/ui/field-help";
import { Label } from "@repo/ui/label";
import { cn } from "@repo/ui/utils";

/** A `*` that marks a required field. */
export function RequiredMark() {
	return <span className="text-destructive"> *</span>;
}

/** An inline `(?)` popover explaining a single field in plain language. */
export function FieldHelp({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return <UiFieldHelp title={title}>{description}</UiFieldHelp>;
}

/** A field's label row: text + optional required mark + optional help popover. */
export function FieldLabel({
	children,
	required,
	help,
	className,
}: {
	children: React.ReactNode;
	required?: boolean;
	help?: { title: string; description: string };
	className?: string;
}) {
	return (
		<div className={cn("flex items-center gap-1.5", className)}>
			<Label className="text-sm">
				{children}
				{required && <RequiredMark />}
			</Label>
			{help && <FieldHelp title={help.title} description={help.description} />}
		</div>
	);
}
