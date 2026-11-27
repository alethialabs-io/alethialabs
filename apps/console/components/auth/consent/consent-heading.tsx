// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type React from "react";

interface ConsentHeadingProps {
	/** The small line above the heading ("Connect an app", "Connected"). */
	eyebrow: string;
	/** The heading: what the screen asks, or what happened. */
	title: string;
	/** The sentence under it. */
	children?: React.ReactNode;
	/** The heading's id, for a region it names. */
	id?: string;
}

/**
 * The consent screen's heading block: eyebrow, the page's one `<h1>`, and the lede. It is the only
 * heading of its kind in the console outside sign-in: the screen sits in `AuthShell`, with no sidebar
 * and no breadcrumb, so nothing else on screen says what it is (the recorded decision is in
 * `shared-surface-allowlist.yaml`).
 */
export function ConsentHeading({ eyebrow, title, children, id }: ConsentHeadingProps) {
	return (
		<div className="space-y-3">
			<p className="vx-eyebrow">{eyebrow}</p>
			<h1
				id={id}
				className="font-grotesk text-display-sm font-semibold leading-[1.05] tracking-display text-text-primary"
			>
				{title}
			</h1>
			{children ? <p className="text-ui-lg text-text-tertiary">{children}</p> : null}
		</div>
	);
}
