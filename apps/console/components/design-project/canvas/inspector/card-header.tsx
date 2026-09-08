"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { cn } from "@repo/ui/utils";

/**
 * The header every component card wears: the kind's icon, the resource's editable name (or the
 * kind's label where the identity IS the kind), the kind eyebrow, a one-line live summary, and
 * close.
 *
 * Extracted from the inspector so the generic card chrome and the kind cards cannot drift into two
 * headers — a database and a queue are different resources, but "what is this and what is it
 * called" is the same question, asked in the same place, on every one of them.
 */
export function CardHeader({
	icon,
	eyebrow,
	name,
	onNameChange,
	nameMono,
	nameMaxLength,
	namePlaceholder,
	title,
	summary,
	onClose,
}: {
	icon?: ReactNode;
	/** The kind badge — DATABASE, QUEUE, PROJECT. */
	eyebrow: string;
	/** The editable display name. Omit `onNameChange` for a kind whose name is not editable. */
	name?: string;
	onNameChange?: (next: string) => void;
	nameMono?: boolean;
	nameMaxLength?: number;
	namePlaceholder?: string;
	/** Shown instead of the name field when the kind has no editable name. */
	title?: string;
	/** One line under the name: what this resource currently is (engine, size, mode). */
	summary?: ReactNode;
	onClose: () => void;
}) {
	return (
		<div className="flex items-start gap-3 border-b border-border p-4">
			{icon && (
				<span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-none border text-muted-foreground">
					{icon}
				</span>
			)}
			<div className="min-w-0 flex-1 space-y-1">
				<div className="flex flex-wrap items-center gap-2">
					{onNameChange ? (
						<Input
							value={name ?? ""}
							maxLength={nameMaxLength}
							placeholder={namePlaceholder}
							onChange={(e) => onNameChange(e.target.value)}
							className={cn(
								"h-8 max-w-[16rem] border-0 bg-transparent px-0 text-base font-semibold shadow-none focus-visible:ring-0",
								nameMono && "font-mono",
							)}
						/>
					) : (
						<span className="text-base font-semibold">{title}</span>
					)}
					<span className="vx-eyebrow rounded-none border border-border px-1.5 py-0.5">
						{eyebrow}
					</span>
				</div>
				<p className="truncate text-xs text-muted-foreground">{summary}</p>
			</div>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="h-7 w-7 shrink-0"
				onClick={onClose}
				aria-label="Close"
			>
				<X className="h-4 w-4" />
			</Button>
		</div>
	);
}
