// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type CSSProperties, type ReactNode } from "react";
import { disp, SecMark, Wrap } from "../primitives";

/**
 * SectionShell — the consistent vertical rhythm every content section sits in:
 * a top hairline border, optional muted (sunken) background, and a `SecMark`
 * "NN — LABEL" eyebrow above a sentence-case display title. Header renders only
 * when `label` (and optionally `n`) are given; `title` renders only when set.
 */
export function SectionShell({
	n,
	label,
	title,
	children,
	muted = false,
	id,
	className,
	style,
}: {
	n?: string;
	label?: string;
	title?: string;
	children: ReactNode;
	muted?: boolean;
	id?: string;
	className?: string;
	style?: CSSProperties;
}) {
	return (
		<section
			id={id}
			className={className}
			style={{
				borderTop: "1px solid var(--border)",
				background: muted ? "var(--surface-sunken)" : "transparent",
				padding: "96px 0",
				position: "relative",
				...style,
			}}
		>
			<Wrap>
				{label ? <SecMark n={n ?? ""} label={label} /> : null}
				{title ? (
					<h2
						style={{
							...disp,
							fontFamily: "var(--font-grotesk)",
							fontSize: 34,
							lineHeight: 1.1,
							fontWeight: 600,
							letterSpacing: "-0.02em",
							color: "var(--text-primary)",
							margin: "0 0 22px",
							maxWidth: 780,
						}}
					>
						{title}
					</h2>
				) : null}
				{children}
			</Wrap>
		</section>
	);
}
