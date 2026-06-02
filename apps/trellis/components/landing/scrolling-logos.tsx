interface Logo {
	name: string;
	icon: string;
}

const LOGOS: Logo[] = [
	{ name: "AWS", icon: "/aws/favicon_32x32.png" },
	{ name: "GCP", icon: "/gcp/favicon_32x32.png" },
	{ name: "Azure", icon: "/azure/favicon_32x32.png" },
	{ name: "GitHub", icon: "/icons/github/github-32x32.png" },
	{ name: "GitLab", icon: "/icons/gitlab/gitlab-32x32.png" },
	{ name: "Bitbucket", icon: "/icons/bitbucket/bitbucket-32x32.png" },
	{ name: "Prometheus", icon: "/icons/prometheus/prometheus-32x32.png" },
	{ name: "Grafana", icon: "/icons/grafana/grafana-32x32.png" },
	{ name: "Datadog", icon: "/icons/datadog/datadog-32x32.png" },
	{ name: "Cloudflare", icon: "/icons/cloudflare/cloudflare-32x32.png" },
	{ name: "Vault", icon: "/icons/vault/vault-32x32.png" },
	{ name: "Docker Hub", icon: "/icons/dockerhub/dockerhub-32x32.png" },
];

export function ScrollingLogos() {
	const doubled = [...LOGOS, ...LOGOS];

	return (
		<div className="relative w-full overflow-hidden py-6">
			{/* Fade edges */}
			<div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-20 bg-gradient-to-r from-background to-transparent" />
			<div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-20 bg-gradient-to-l from-background to-transparent" />

			<div className="flex w-max animate-scroll hover:[animation-play-state:paused]">
				{doubled.map((logo, i) => (
					<div
						key={`${logo.name}-${i}`}
						className="mx-6 flex shrink-0 items-center gap-2"
					>
						<img
							src={logo.icon}
							alt={logo.name}
							className="h-6 w-6 opacity-40 grayscale transition-all hover:opacity-80 hover:grayscale-0"
						/>
						<span className="text-xs text-muted-foreground/50">
							{logo.name}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}
