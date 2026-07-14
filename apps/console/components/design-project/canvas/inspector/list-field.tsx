"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Plus, X } from "lucide-react";
import { Button } from "@repo/ui/button";
import { Input } from "@repo/ui/input";
import { cn } from "@repo/ui/utils";

/**
 * A `string[]` column — CIDR allow-lists, CORS origins, cluster admins, global replicas.
 *
 * These were previously either absent from the panel entirely, or crammed into a single
 * comma-separated text box, which quietly makes a value with a comma in it unrepresentable.
 */
export function ListField({
	value,
	onChange,
	placeholder,
	mono,
	ariaLabel,
}: {
	value: string[];
	onChange: (next: string[]) => void;
	placeholder?: string;
	mono?: boolean;
	ariaLabel: string;
}) {
	const rows = value ?? [];

	const update = (index: number, next: string) =>
		onChange(rows.map((row, i) => (i === index ? next : row)));

	// An empty row is dropped rather than saved — a blank CIDR is not a value, and letting one
	// through would fail validation at deploy with a confusing message.
	const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));

	return (
		<div className="border border-border">
			{rows.length > 0 && (
				<ul>
					{rows.map((row, i) => (
						// Rows are positional (a list of plain strings has no stable id), so the index IS
						// the identity here.
						// eslint-disable-next-line react/no-array-index-key
						<li key={i} className="flex items-center gap-1.5 border-b border-border/60 p-1.5">
							<Input
								value={row}
								onChange={(e) => update(i, e.target.value)}
								placeholder={placeholder}
								aria-label={`${ariaLabel} ${i + 1}`}
								className={cn("h-8 border-0 shadow-none focus-visible:ring-0", mono && "font-mono text-xs")}
							/>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
								aria-label={`Remove ${ariaLabel} ${i + 1}`}
								onClick={() => remove(i)}
							>
								<X className="h-3.5 w-3.5" />
							</Button>
						</li>
					))}
				</ul>
			)}
			<button
				type="button"
				onClick={() => onChange([...rows, ""])}
				className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
			>
				<Plus className="h-3.5 w-3.5" />
				Add
			</button>
		</div>
	);
}
