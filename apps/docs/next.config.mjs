// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
	basePath: "/docs",
	output: "standalone",
	reactStrictMode: true,
	async rewrites() {
		return [
			{
				source: "/:path*.mdx",
				destination: "/llms.mdx/:path*",
			},
		];
	},
	async redirects() {
		return [
			// CLI docs renamed grape -> cli
			{ source: "/grape", destination: "/cli", permanent: true },
			{ source: "/grape/:path*", destination: "/cli/:path*", permanent: true },
			// Shared Go package renamed grape-core -> core
			{ source: "/tendril/grape-core", destination: "/tendril/core", permanent: true },
		];
	},
};

export default withMDX(config);
