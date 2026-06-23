// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alethia bracketed-point mark [ · ].
export function Mark({ size = 20 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
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
