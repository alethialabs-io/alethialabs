// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ICON_MARK_SIZE, ICON_MARK_SVG, ICON_RADIUS, ICON_SIZE } from "./icon-svg";
import { BRAND_BLACK } from "./ramp-srgb";

import { ImageResponse } from "next/og";

export const size = { width: ICON_SIZE, height: ICON_SIZE };
export const contentType = "image/png";

/** Favicon — dark rounded square + light bracketed mark. Its geometry lives in `icon-svg.ts`, shared with the status Worker. */
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
					background: BRAND_BLACK,
					borderRadius: ICON_RADIUS,
				}}
			>
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img
					width={ICON_MARK_SIZE}
					height={ICON_MARK_SIZE}
					alt=""
					src={`data:image/svg+xml;utf8,${encodeURIComponent(ICON_MARK_SVG)}`}
				/>
			</div>
		),
		{ ...size },
	);
}
