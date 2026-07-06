// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "standalone",
	// Monorepo: trace workspace files from the repo root so the standalone
	// bundle is self-contained inside Docker.
	outputFileTracingRoot: path.join(__dirname, "../../"),
	// Shared workspace packages ship raw TS/TSX — Next must transpile them.
	transpilePackages: ["@repo/ui", "@repo/brand", "@repo/plan-catalog", "@repo/email"],
	// Marketing owns the bare root, so NO basePath. A custom asset prefix keeps its
	// /_next/* assets off the console's root (the console owns the `/{org}` wildcard).
	// Must match the assetPrefix in apps/console/microfrontends.json and the Caddy
	// /mkt-assets route. public/ files referenced at the prefix live under public/mkt-assets/.
	assetPrefix: "/mkt-assets",
};

export default nextConfig;
