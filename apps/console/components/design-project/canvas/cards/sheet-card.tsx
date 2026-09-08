"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@repo/ui/button";
import { SectionHeading } from "@repo/ui/section-heading";
import { cn } from "@repo/ui/utils";

/**
 * The chrome every card on the workspace rail shares — a header (icon · eyebrow · title ·
 * description · actions · close), a body that scrolls on its own, and an optional footer pinned
 * to the bottom so a long form never pushes its actions off screen.
 *
 * This is the NON-blocking cousin of `@repo/ui/detail-sheet`: a `DetailSheet` is a Dialog with an
 * overlay, and the Architecture page had four of those (environment settings, an add-on's config,
 * two scan verdicts) beside one docked inspector — so opening any of them stopped you editing the
 * board they were about. A card is an in-flow flex child of the rail; the board stays live, and a
 * card and the Elench assistant can be open side by side.
 *
 * Lives in the console, not `packages/ui`, because it is bound to the rail's geometry and the
 * canvas idioms (`vx-eyebrow`); promote it only if a second host appears.
 */
export function SheetCard({
	title,
	eyebrow,
	icon,
	description,
	actions,
	footer,
	header,
	onClose,
	className,
	bodyClassName,
	children,
}: {
	/** The card's name. Rendered through `SectionHeading`, so text or an inline node. */
	title: ReactNode;
	/** The small uppercase label above the title (a kind, a category). */
	eyebrow?: ReactNode;
	/** A 16px icon in the header's leading box. */
	icon?: ReactNode;
	/** One line under the title. Omit rather than restate the title. */
	description?: ReactNode;
	/** Buttons beside the close control. */
	actions?: ReactNode;
	/** Pinned to the bottom, outside the scrolling body. */
	footer?: ReactNode;
	/** Replace the whole header (the node inspector keeps its editable-name header). */
	header?: ReactNode;
	onClose: () => void;
	className?: string;
	bodyClassName?: string;
	children: ReactNode;
}) {
	return (
		<div className={cn("flex h-full min-h-0 flex-col", className)}>
			{header ?? (
				<div className="flex items-start gap-3 border-b border-border p-4">
					{icon && (
						<span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-none border text-muted-foreground">
							{icon}
						</span>
					)}
					<div className="min-w-0 flex-1">
						{eyebrow && <span className="vx-eyebrow block pb-1">{eyebrow}</span>}
						<SectionHeading level={2} title={title} description={description} />
					</div>
					<div className="flex shrink-0 items-center gap-1">
						{actions}
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="h-7 w-7"
							onClick={onClose}
							aria-label="Close"
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				</div>
			)}
			<div className={cn("min-h-0 flex-1 overflow-y-auto px-4 py-4", bodyClassName)}>
				{children}
			</div>
			{footer && (
				<div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-3">
					{footer}
				</div>
			)}
		</div>
	);
}
