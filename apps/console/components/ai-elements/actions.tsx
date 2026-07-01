"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AI Elements `Actions` — per-message action buttons (copy, retry, …). Vendored to
// match the AI Elements API (the standalone registry item wasn't published in this
// registry version); wired to the repo's @repo/ui primitives like the other elements.

import type { ComponentProps } from "react";
import { Button } from "@repo/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";

export type ActionsProps = ComponentProps<"div">;

/** A horizontal group of per-message action buttons. */
export const Actions = ({ className, children, ...props }: ActionsProps) => (
	<div className={cn("flex items-center gap-1", className)} {...props}>
		{children}
	</div>
);

export type ActionProps = ComponentProps<typeof Button> & {
	tooltip?: string;
	label?: string;
};

/** A single icon action button with an optional tooltip + accessible label. */
export const Action = ({
	tooltip,
	label,
	children,
	className,
	variant = "ghost",
	size = "icon",
	...props
}: ActionProps) => {
	const button = (
		<Button
			className={cn(
				"relative size-7 p-1 text-muted-foreground hover:text-foreground",
				className,
			)}
			size={size}
			type="button"
			variant={variant}
			{...props}
		>
			{children}
			<span className="sr-only">{label || tooltip}</span>
		</Button>
	);

	if (!tooltip) return button;
	return (
		<Tooltip>
			<TooltipTrigger asChild>{button}</TooltipTrigger>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	);
};
