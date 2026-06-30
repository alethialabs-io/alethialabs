"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The canonical "?" help affordance placed next to a form label: a small HelpCircle
// button that opens a popover with a short explanation. Shared design-system component
// (alerts/runners/connectors all use this instead of their own copies).

import { HelpCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "./utils";

interface FieldHelpProps {
	title: string;
	children: ReactNode;
	className?: string;
}

/** A "?" popover for inline field guidance (title + free-form explanation). */
export function FieldHelp({ title, children, className }: FieldHelpProps) {
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={`Help: ${title}`}
					className={cn(
						"inline-flex items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:text-foreground",
						className,
					)}
				>
					<HelpCircle className="size-3.5" />
				</button>
			</PopoverTrigger>
			<PopoverContent side="top" align="start" className="w-72 p-3">
				<p className="mb-1 font-medium text-foreground text-xs">{title}</p>
				<div className="text-muted-foreground text-xs leading-relaxed">
					{children}
				</div>
			</PopoverContent>
		</Popover>
	);
}
