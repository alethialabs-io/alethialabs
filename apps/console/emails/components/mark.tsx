// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { colors } from "./theme";

interface MarkProps {
	size?: number;
	color?: string;
}

/**
 * The Alethia "bracketed point" [·] mark — inline SVG in currentColor.
 * Note: Gmail strips inline SVG; for production, swap for a hosted PNG.
 */
export function Mark({ size = 24, color = colors.textPrimary }: MarkProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 32 32"
			fill="none"
			className="a-mark"
			style={{ display: "inline-block", verticalAlign: "middle", color }}
			aria-label="Alethia Labs"
		>
			<path
				d="M11 6 H6.5 V26 H11"
				stroke="currentColor"
				strokeWidth="2.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<path
				d="M21 6 H25.5 V26 H21"
				stroke="currentColor"
				strokeWidth="2.4"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
			<circle cx="16" cy="16" r="2.9" fill="currentColor" />
		</svg>
	);
}
