// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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
		background_color: "#0A0A0A",
		theme_color: "#0A0A0A",
		icons: [
			{ src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
			{
				src: "/apple-icon.svg",
				type: "image/svg+xml",
				sizes: "any",
				purpose: "maskable",
			},
		],
	};
}
