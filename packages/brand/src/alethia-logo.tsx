// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { SVGProps } from "react";

interface AlethiaLogoProps extends SVGProps<SVGSVGElement> {
	withText?: boolean;
}

/**
 * Alethia "bracketed point" mark — two brackets framing a center dot, drawn in
 * `currentColor`. Icon-only, or with the "Alethia Labs" company lockup when
 * `withText` is set.
 */
export function AlethiaLogo({ withText, ...props }: AlethiaLogoProps) {
	if (withText) {
		return (
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 150 32"
				fill="none"
				{...props}
			>
				{/* Mark */}
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
				{/* Wordmark */}
				<text
					x="40"
					y="22.5"
					fill="currentColor"
					fontFamily="'Space Grotesk', system-ui, sans-serif"
					fontSize="20"
					fontWeight="600"
					letterSpacing="-0.02em"
				>
					Alethia
				</text>
				<text
					x="112"
					y="21"
					fill="currentColor"
					fillOpacity="0.55"
					fontFamily="'Geist Mono', ui-monospace, monospace"
					fontSize="10"
					fontWeight="500"
					letterSpacing="0.26em"
				>
					LABS
				</text>
			</svg>
		);
	}

	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 32 32"
			fill="none"
			{...props}
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
