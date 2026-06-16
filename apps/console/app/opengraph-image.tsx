// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ImageResponse } from "next/og";

export const alt =
	"Alethia — configure multi-cloud infrastructure in the browser, deploy from the terminal";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The bracketed-point mark, light on dark, as an inline SVG data URI. */
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"><path d="M11 6 H6.5 V26 H11" stroke="#FAFAFA" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 6 H25.5 V26 H21" stroke="#FAFAFA" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="16" r="2.9" fill="#FAFAFA"/></svg>`;

/** Social card — dark canvas, bracketed mark + Alethia wordmark + tagline. */
export default function OpengraphImage() {
	return new ImageResponse(
		(
			<div
				style={{
					height: "100%",
					width: "100%",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					background: "#0A0A0A",
					color: "#FAFAFA",
					fontFamily: "sans-serif",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 28 }}>
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img
						width={120}
						height={120}
						alt=""
						src={`data:image/svg+xml;utf8,${encodeURIComponent(MARK)}`}
					/>
					<div
						style={{
							fontSize: 120,
							fontWeight: 600,
							letterSpacing: "-0.04em",
						}}
					>
						Alethia
					</div>
				</div>
				<div
					style={{
						marginTop: 32,
						fontSize: 30,
						color: "#A1A1AA",
						maxWidth: 820,
						textAlign: "center",
					}}
				>
					Configure multi-cloud infrastructure in the browser. Deploy from the
					terminal.
				</div>
			</div>
		),
		{ ...size },
	);
}
