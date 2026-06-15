// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "standalone",
	async rewrites() {
		const docsUrl = process.env.DOCS_URL;
		if (!docsUrl) return [];
		return [
			{
				source: "/docs",
				destination: `${docsUrl}/docs`,
			},
			{
				source: "/docs/:path*",
				destination: `${docsUrl}/docs/:path*`,
			},
		];
	},
};

export default nextConfig;
