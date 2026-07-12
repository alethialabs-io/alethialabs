// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import path from "node:path";
import type { NextConfig } from "next";

// Cross-origin dev/proxy origins to allow (the public tunnel — Cloudflare quick tunnel /
// ngrok — that `dev:stack`/`dev:tunnel` front the app with). Without this, Next blocks
// cross-origin requests from the tunnel host (server actions, /_next/*, HMR) and the
// browser reports "Load failed". The exact host comes from the env dev-stack injects; the
// wildcards cover a new random quick-tunnel URL without re-editing.
const PUBLIC_DEV_ORIGINS = (() => {
	const out = new Set<string>([
		"*.trycloudflare.com",
		"*.ngrok-free.app",
		"*.ngrok.app",
	]);
	const raw =
		process.env.ALETHIA_PUBLIC_URL ||
		process.env.NEXT_PUBLIC_APP_URL ||
		process.env.BETTER_AUTH_URL;
	if (raw) {
		try {
			out.add(new URL(raw).host);
		} catch {
			// Ignore an unparseable URL — the wildcards still cover the tunnel.
		}
	}
	return [...out];
})();

const nextConfig: NextConfig = {
	output: "standalone",
	// Allow the tunnel host to make cross-origin dev requests (server actions, /_next/*).
	allowedDevOrigins: PUBLIC_DEV_ORIGINS,
	// Also allow the Server Action Origin check behind the proxy (production-mode renders).
	experimental: { serverActions: { allowedOrigins: PUBLIC_DEV_ORIGINS } },
	// Monorepo: trace workspace files from the repo root so the standalone
	// bundle is self-contained inside Docker.
	outputFileTracingRoot: path.join(__dirname, "../../"),
	// Shared workspace packages ship raw TS/TSX — Next must transpile them.
	transpilePackages: ["@repo/ui", "@repo/brand", "@repo/plan-catalog", "@repo/email", "@repo/support"],
	// The enterprise package is loaded at runtime via createRequire (lib/enterprise.ts),
	// never statically bundled — keep it external so a community build (where the
	// package is absent) doesn't try to resolve it.
	// pino resolves its transport/worker files at runtime — keep it external so the
	// bundler doesn't try to statically trace those dynamic requires.
	// The OpenTelemetry SDK (traces + metrics, wired in instrumentation.ts) similarly
	// resolves exporters/context managers at runtime and is node-only — keep it external
	// so the server bundle doesn't statically trace it (and so an OTLP-less build carries
	// no telemetry weight in the client/edge graphs).
	serverExternalPackages: [
		"@alethia/ee",
		"pino",
		// Sentry error tracking is server-only (booted in instrumentation.ts, DSN-gated). Keep it
		// external — like the OTel packages below — so it is not statically bundled into the
		// client/edge graphs and a DSN-less build carries no error-tracking weight there.
		"@sentry/nextjs",
		"@opentelemetry/api",
		"@opentelemetry/resources",
		"@opentelemetry/sdk-trace-node",
		"@opentelemetry/sdk-metrics",
		"@opentelemetry/exporter-trace-otlp-http",
		"@opentelemetry/exporter-metrics-otlp-http",
	],
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
		// PostHog reverse-proxy: serve analytics ingestion from our own origin so ad-blockers
		// (which block eu.i.posthog.com) stop dropping events. The browser SDK points at
		// `/ingest` (NEXT_PUBLIC_POSTHOG_HOST). PostHog's EU assets live on a separate host from
		// ingest, so the /static/* rule must target eu-assets.
		const posthog = [
			{
				source: "/ingest/static/:path*",
				destination: "https://eu-assets.i.posthog.com/static/:path*",
			},
			{ source: "/ingest/:path*", destination: "https://eu.i.posthog.com/:path*" },
		];
		return { beforeFiles: getHost, afterFiles: [...docs, ...posthog] };
	},
};

// Console is the default zone: it owns the residual (incl. the `/{org}` wildcard). The
// marketing-owned root paths are stitched to the marketing app by Caddy at the edge
// (deploy/prod/Caddyfile.tunnel + deploy/caddy/marketing.caddy), NOT by Next — the path
// map still lives in microfrontends.json (source for RESERVED_SLUGS + the Caddy mirror).
export default nextConfig;
