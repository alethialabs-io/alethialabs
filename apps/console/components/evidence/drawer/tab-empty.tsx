// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The shared per-tab empty state of the evidence drawer — every tab is always
// rendered, so a tab without data explains what's missing and how it comes to exist
// (never a silently blank sheet).

import { EvIcon, type IconKey } from "../evidence-status";

/** A purposeful empty state for one drawer tab: icon, headline, one honest sentence, and a
 * "Learn more →" docs link so the term is never a dead-end. */
export function TabEmpty({
	icon,
	title,
	description,
	docsHref,
	action,
}: {
	icon: IconKey;
	title: string;
	description: string;
	/** Docs link explaining the concept (renders a "Learn more →" affordance). */
	docsHref?: string;
	action?: React.ReactNode;
}) {
	return (
		<div className="rounded-md border border-dashed px-6 py-10 text-center">
			<EvIcon name={icon} size={20} className="mx-auto mb-2.5 text-text-tertiary" />
			<div className="text-[13px] font-medium text-text-primary">{title}</div>
			<p className="mx-auto mt-1 max-w-[40ch] text-[12px] leading-relaxed text-text-tertiary">
				{description}
			</p>
			{docsHref && (
				<a
					href={docsHref}
					className="mt-3 inline-flex items-center gap-1 border-b border-border-strong pb-0.5 font-mono text-[11px] text-text-secondary transition-colors hover:border-text-primary hover:text-text-primary"
				>
					Learn more
					<EvIcon name="arrow-right" size={11} />
				</a>
			)}
			{action && <div className="mt-4">{action}</div>}
		</div>
	);
}
