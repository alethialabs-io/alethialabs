// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { LucideIcon } from "lucide-react";
import { ArrowUpRight } from "lucide-react";
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

/** The card's inner content — icon, title, blurb — shared by the link and disabled variants. */
function SupportCardBody({
	icon: Icon,
	title,
	description,
	external,
}: Pick<SupportCardProps, "icon" | "title" | "description" | "external">) {
	return (
		<div className="flex h-full flex-col gap-3 px-5">
			<div className="flex items-center justify-between">
				<Icon className="h-5 w-5 text-muted-foreground" />
				{external && (
					<ArrowUpRight className="h-4 w-4 text-muted-foreground/60" />
				)}
			</div>
			<div className="space-y-1">
				<h3 className="text-sm font-medium leading-none">{title}</h3>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
		</div>
	);
}

/**
 * A single entry-point card on the support landing grid. The whole card is a link
 * (internal via next/link, or external with a new-tab target); a `disabled` card renders
 * as a muted, non-interactive panel for surfaces that aren't available yet. Grayscale
 * hover treatment matches the rest of the console.
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
			<Card className="gap-0 py-5 opacity-60">
				<SupportCardBody
					icon={icon}
					title={title}
					description={description}
				/>
			</Card>
		);
	}

	const cardClass = cn(
		"gap-0 py-5 transition-colors hover:border-foreground/30 hover:bg-muted/40",
	);

	if (external) {
		return (
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				className="block h-full focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-xl"
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
		<Link
			href={href}
			className="block h-full focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-xl"
		>
			<Card className={cardClass}>
				<SupportCardBody
					icon={icon}
					title={title}
					description={description}
				/>
			</Card>
		</Link>
	);
}
