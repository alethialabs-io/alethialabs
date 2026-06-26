// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** The bracketed-point mark, light on dark, as an inline SVG data URI. */
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><path d="M11 6 H6.5 V26 H11" stroke="#FAFAFA" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 6 H25.5 V26 H21" stroke="#FAFAFA" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="16" r="2.9" fill="#FAFAFA"/></svg>`;

/** Favicon — dark rounded square + light bracketed mark. */
export default function Icon() {
	return new ImageResponse(
		(
			<div
				style={{
					width: "100%",
					height: "100%",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					background: "#1A1A1A",
					borderRadius: 7,
				}}
			>
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img
					width={25}
					height={25}
					alt=""
					src={`data:image/svg+xml;utf8,${encodeURIComponent(MARK)}`}
				/>
			</div>
		),
		{ ...size },
	);
}
