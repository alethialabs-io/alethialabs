// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from "./sheet";
import { cn } from "./utils";

/**
 * A right-hand drawer showing one record — the console's most repeated layout.
 *
 * Twenty-three Sheet-based detail drawers exist across the console and each solves the same
 * problem differently: a connector's sheet, an evidence drawer, a classification value drill, a
 * promotion overlay that is not even a Sheet. They disagree on header structure, on whether the
 * body scrolls, and on where footer actions sit.
 *
 * This fixes those three decisions and leaves everything else to the caller:
 *   - the header is title (+ optional description, + optional trailing node such as a StatusBadge)
 *   - the body scrolls independently, so a long record never pushes the actions off-screen
 *   - the footer pins to the bottom
 *
 * Controlled only. A detail drawer is always driven by "which row did they click", so an
 * uncontrolled variant would just invite two sources of truth.
 */
function DetailSheet({
	open,
	onOpenChange,
	title,
	description,
	badge,
	footer,
	side = "right",
	className,
	children,
	...props
}: Omit<React.ComponentProps<typeof SheetContent>, "title" | "children"> & {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The record's name. */
	title: React.ReactNode;
	/** One line identifying the record further — an id, an owner, a path. */
	description?: React.ReactNode;
	/** Trailing header slot, for a StatusBadge or similar. */
	badge?: React.ReactNode;
	/** Pinned actions. Omit for a read-only drawer. */
	footer?: React.ReactNode;
	children?: React.ReactNode;
}) {
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent side={side} className={cn("flex flex-col gap-0 p-0", className)} {...props}>
				<SheetHeader className="gap-1 border-b p-6">
					<div className="flex items-start justify-between gap-3">
						<SheetTitle className="min-w-0 truncate">{title}</SheetTitle>
						{badge ? <div className="shrink-0">{badge}</div> : null}
					</div>
					{/* Always rendered: base-ui warns when a dialog has no description, and an
					    empty one is the accessible equivalent of the caller omitting it. */}
					<SheetDescription className={description ? undefined : "sr-only"}>
						{description ?? `Details for ${typeof title === "string" ? title : "this record"}`}
					</SheetDescription>
				</SheetHeader>
				{/* min-h-0 is load-bearing: without it a flex child refuses to shrink below its
				    content and the panel scrolls as a whole, taking the footer with it. */}
				<div data-slot="detail-sheet-body" className="min-h-0 flex-1 overflow-y-auto p-6">
					{children}
				</div>
				{footer ? <SheetFooter className="border-t p-6">{footer}</SheetFooter> : null}
			</SheetContent>
		</Sheet>
	);
}

export { DetailSheet };
