// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "standalone",
	async rewrites() {
		// Serve the CLI install script at the root of get.alethialabs.io
		// (`curl -fsSL https://get.alethialabs.io | sh`). install.ps1 is reached
		// directly at /install.ps1. Both files live in public/.
		const getHost = [
			{
				source: "/",
				has: [{ type: "host" as const, value: "get.alethialabs.io" }],
				destination: "/install.sh",
			},
		];
		const docsUrl = process.env.DOCS_URL;
		const docs = docsUrl
			? [
					{ source: "/docs", destination: `${docsUrl}/docs` },
					{ source: "/docs/:path*", destination: `${docsUrl}/docs/:path*` },
				]
			: [];
		return { beforeFiles: getHost, afterFiles: docs };
	},
};

export default nextConfig;
