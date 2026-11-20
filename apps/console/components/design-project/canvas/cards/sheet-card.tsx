"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { SectionHeading } from "@repo/ui/section-heading";
import { cn } from "@repo/ui/utils";
import { InspectorFrame, useInspectorEmbedded } from "../inspector-shell/inspector-frame";

/**
 * A card on the workspace rail, for a host that is not one of the inspector's own subjects (the
 * activity log, a scan verdict).
 *
 * It draws nothing of its own any more: on the rail it IS the inspector's frame
 * (`InspectorFrame`), so its header, its close control and its messages sit exactly where every
 * other subject's do. Inside a frame that is already on screen — a tab of the environment subject
 * — it is a section with a heading, because a second header and a second close control under the
 * first would be the two-layouts problem the one inspector exists to remove.
 *
 * It has no footer. A card's footer was where its own Save lived, and nothing on the rail commits
 * from the rail any more.
 *
 * Lives in the console, not `packages/ui`, because it is bound to the rail and the canvas idioms.
 */
export function SheetCard({
	title,
	eyebrow,
	icon,
	description,
	actions,
	onClose,
	className,
	bodyClassName,
	children,
}: {
	/** The card's name. Text or an inline node. */
	title: ReactNode;
	/** The small uppercase label above the title (a kind, a category). */
	eyebrow?: ReactNode;
	/** A 16px icon in the header's leading plate. */
	icon?: ReactNode;
	/** One line under the title. Omit rather than restate the title. */
	description?: ReactNode;
	/** The card's primary action, beside the close control. */
	actions?: ReactNode;
	onClose: () => void;
	className?: string;
	bodyClassName?: string;
	children: ReactNode;
}) {
	const embedded = useInspectorEmbedded();
	if (embedded) {
		return (
			<section className={cn("space-y-3", className)}>
				<SectionHeading level={3} title={title} description={description} actions={actions} />
				<div className={bodyClassName}>{children}</div>
			</section>
		);
	}
	return (
		<InspectorFrame
			icon={icon}
			eyebrow={eyebrow}
			title={title}
			summary={description}
			action={actions}
			onClose={onClose}
			className={className}
			bodyClassName={bodyClassName}
		>
			{children}
		</InspectorFrame>
	);
}
