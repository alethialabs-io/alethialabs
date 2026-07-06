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
	transpilePackages: ["@repo/ui", "@repo/brand", "@repo/email", "@repo/support"],
	// The staff dashboard runs on its OWN subdomain behind Cloudflare Access, so it
	// owns the bare root and needs NO assetPrefix (unlike the marketing child zone).
};

export default nextConfig;
