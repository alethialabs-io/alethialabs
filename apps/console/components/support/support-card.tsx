// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { LucideIcon } from "lucide-react";
import { ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Card } from "@repo/ui/card";
import { cn } from "@repo/ui/utils";

interface SupportCardProps {
	/** Leading lucide icon for the card. */
	icon: LucideIcon;
	/** Card heading. */
	title: string;
	/** One-line blurb under the heading. */
	description: string;
	/** Navigation target; omit (with `disabled`) for a non-interactive "coming soon" card. */
	href?: string;
	/** Render as an external link (new tab) with an outbound affordance. */
	external?: boolean;
	/** Muted, non-interactive treatment (no link). */
	disabled?: boolean;
}

/**
 * The card's inner content — icon top-left, a trailing arrow that slides on hover, then the
 * title + blurb. The arrow is the internal "go" affordance (ArrowRight, animated) or the
 * external new-tab mark (ArrowUpRight); a disabled card shows neither.
 */
function SupportCardBody({
	icon: Icon,
	title,
	description,
	external,
	disabled,
}: Pick<
	SupportCardProps,
	"icon" | "title" | "description" | "external" | "disabled"
>) {
	return (
		<div className="flex h-full flex-col px-6">
			<div className="flex items-start justify-between">
				<Icon className="size-[22px] text-muted-foreground" />
				{!disabled &&
					(external ? (
						<ArrowUpRight className="size-4 text-muted-foreground/50" />
					) : (
						<ArrowRight className="size-[18px] text-muted-foreground/50 transition-[transform,color] duration-150 group-hover:translate-x-[3px] group-hover:text-foreground" />
					))}
			</div>
			<h3 className="mt-6 text-lg font-semibold tracking-tight">{title}</h3>
			<p className="mt-1 text-sm text-muted-foreground">{description}</p>
		</div>
	);
}

/**
 * A single entry-point card on the support landing grid. The whole card is a link (internal
 * via next/link, or external in a new tab); a `disabled` card renders as a muted,
 * non-interactive panel for surfaces that aren't available yet. Grayscale hover treatment
 * (border + surface lift + arrow slide) matches the rest of the console.
 */
export function SupportCard({
	icon,
	title,
	description,
	href,
	external,
	disabled,
}: SupportCardProps) {
	if (disabled || !href) {
		return (
			<Card className="gap-0 py-6 opacity-60">
				<SupportCardBody
					icon={icon}
					title={title}
					description={description}
					disabled
				/>
			</Card>
		);
	}

	const cardClass = cn(
		"h-full gap-0 py-6 transition-colors duration-150 group-hover:border-foreground/20 group-hover:bg-muted/40",
	);
	const wrapperClass =
		"group block h-full rounded-xl focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50";

	if (external) {
		return (
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				className={wrapperClass}
			>
				<Card className={cardClass}>
					<SupportCardBody
						icon={icon}
						title={title}
						description={description}
						external
					/>
				</Card>
			</a>
		);
	}

	return (
		<Link href={href} className={wrapperClass}>
			<Card className={cardClass}>
				<SupportCardBody icon={icon} title={title} description={description} />
			</Card>
		</Link>
	);
}
