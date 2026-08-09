// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BRAND_BLACK } from "./ramp-srgb";

import type { MetadataRoute } from "next";

/** PWA web app manifest — grayscale Alethia branding. */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Alethia",
		short_name: "Alethia",
		description:
			"Configure multi-cloud infrastructure in the browser. Deploy from the terminal.",
		start_url: "/",
		display: "standalone",
		background_color: BRAND_BLACK,
		theme_color: BRAND_BLACK,
		icons: [
			{ src: "/icon", type: "image/png", sizes: "32x32" },
			{
				src: "/apple-icon",
				type: "image/png",
				sizes: "180x180",
				purpose: "maskable",
			},
		],
	};
}
