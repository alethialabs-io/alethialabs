// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ProviderIcon } from "@/components/provider-icon";

interface Logo {
	name: string;
	slug?: string;
	iconPath?: string;
}

const KNOWN_PROVIDERS = new Set(["aws", "gcp", "azure", "github", "gitlab", "bitbucket"]);

const LOGOS: Logo[] = [
	{ name: "AWS", slug: "aws" },
	{ name: "GCP", slug: "gcp" },
	{ name: "Azure", slug: "azure" },
	{ name: "GitHub", slug: "github" },
	{ name: "GitLab", slug: "gitlab" },
	{ name: "Bitbucket", slug: "bitbucket" },
	{ name: "Prometheus", iconPath: "/icons/prometheus/prometheus-32x32.png" },
	{ name: "Grafana", iconPath: "/icons/grafana/grafana-32x32.png" },
	{ name: "Datadog", iconPath: "/icons/datadog/datadog-32x32.png" },
	{ name: "Cloudflare", iconPath: "/icons/cloudflare/cloudflare-32x32.png" },
	{ name: "Vault", iconPath: "/icons/vault/vault-32x32.png" },
	{ name: "Docker Hub", iconPath: "/icons/dockerhub/dockerhub-32x32.png" },
];

export function ScrollingLogos() {
	const doubled = [...LOGOS, ...LOGOS];

	return (
		<div className="relative w-full overflow-hidden py-6">
			<div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-20 bg-gradient-to-r from-background to-transparent" />
			<div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-20 bg-gradient-to-l from-background to-transparent" />

			<div className="flex w-max animate-scroll hover:[animation-play-state:paused]">
				{doubled.map((logo, i) => (
					<div
						key={`${logo.name}-${i}`}
						className="mx-6 flex shrink-0 items-center gap-2"
					>
						{logo.slug && KNOWN_PROVIDERS.has(logo.slug) ? (
							<ProviderIcon
								provider={logo.slug}
								size={24}
								className="opacity-40 grayscale transition-all hover:opacity-80 hover:grayscale-0"
							/>
						) : logo.iconPath ? (
							<img
								src={logo.iconPath}
								alt={logo.name}
								className="h-6 w-6 opacity-40 grayscale transition-all hover:opacity-80 hover:grayscale-0"
							/>
						) : null}
						<span className="text-xs text-muted-foreground/50">
							{logo.name}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}
