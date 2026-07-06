// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../");

/** @type {import('next').NextConfig} */
const config = {
	basePath: "/docs",
	output: "standalone",
	// Monorepo: trace workspace files from the repo root for a self-contained
	// standalone bundle inside Docker.
	outputFileTracingRoot: repoRoot,
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
			// Platform docs renamed trellis -> console
			{ source: "/trellis", destination: "/console", permanent: true },
			{ source: "/trellis/:path*", destination: "/console/:path*", permanent: true },
			// Runner/agent docs renamed tendril -> runner
			{ source: "/tendril", destination: "/runner", permanent: true },
			{ source: "/tendril/:path*", destination: "/runner/:path*", permanent: true },
			// Shared Go package renamed grape-core -> core (now under runner/)
			{ source: "/runner/grape-core", destination: "/runner/core", permanent: true },
		];
	},
};

export default withMDX(config);
