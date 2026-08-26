// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "standalone",
	// Monorepo: trace workspace files from the repo root so the standalone
	// bundle is self-contained inside Docker.
	outputFileTracingRoot: path.join(__dirname, "../../"),
	// next@16.3.1's output-file-tracing copies the CJS half of a dual-package export and misses the
	// ESM half. `@swc/helpers` declares
	//     "./_/_interop_require_default": { import: "./esm/…js", default: "./cjs/….cjs" }
	// so the tracer followed `default` (cjs) while the runtime resolved `import` (esm) — the
	// standalone bundle shipped `cjs/` + package.json and nothing else, 3 files out of 438.
	//
	// Every Next app in this repo then crash-looped at boot with
	//     Cannot find module '…/@swc/helpers/esm/_interop_require_default.js'
	// and prod served 502 behind a healthy caddy for ~45 minutes on 2026-08-26. The deploy reported
	// SUCCESS throughout, because nothing between `next build` and Cloudflare ever asked whether the
	// image could start.
	//
	// It broke on the @swc/helpers 0.5.15 -> 0.5.23 bump in #2405 (a 38-package batch), not on a
	// Next upgrade — so pinning Next would not have prevented it and will not prevent the next one.
	//
	// The whole package is included rather than just `esm/**`: it is ~438 small files, and naming
	// one subdirectory would re-create the same guess the tracer already got wrong. The version is
	// globbed so a future bump does not silently reintroduce this.
	outputFileTracingIncludes: {
		"/**/*": ["../../node_modules/.pnpm/@swc+helpers@*/node_modules/@swc/helpers/**"],
	},
	// Shared workspace packages ship raw TS/TSX — Next must transpile them.
	transpilePackages: ["@repo/ui", "@repo/brand", "@repo/email", "@repo/support"],
	// The staff dashboard runs on its OWN subdomain behind Cloudflare Access, so it
	// owns the bare root and needs NO assetPrefix (unlike the marketing child zone).
};

export default nextConfig;
