// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getGitHubStars } from "@/lib/github-stars";
import { Header } from "@/components/landing/home/header";
import { Hero } from "@/components/landing/home/hero";
import { RunsOn } from "@/components/landing/home/runs-on";
import { Showcase } from "@/components/landing/home/showcase";
import { ProveBand, PositioningBand, RoadmapBand } from "@/components/landing/home/bands";
import { OpenSource } from "@/components/landing/home/open-source";
import { Enterprise } from "@/components/landing/home/enterprise";
import { CTA } from "@/components/landing/home/cta";
import { Footer } from "@/components/landing/home/footer";
import { Reveal } from "@/components/landing/home/reveal";

const A = "/mkt-assets/home/dark";

/**
 * Alethia Labs public home page — a real product introduction. Every product
 * surface shown is an authentic screenshot of the running console (see the
 * demo-seed + capture pipeline); no mocks. Served at the bare root by the
 * marketing zone; authenticated visitors are handed to the console first.
 */
export default async function HomePage() {
	const stars = await getGitHubStars();

	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header stars={stars} />
			<Reveal>
				<Hero />
				<RunsOn />
				<Showcase
					n="01"
					label="Own it"
					title="Your clouds. Your accounts. Zero stored keys."
					body="Connect AWS, Google Cloud, or Hetzner through short-lived federated identity — Alethia holds no static credentials and hosts nothing. Your projects run across clouds, in accounts you own."
					points={["Keyless federated identity — nothing written to disk", "Multi-cloud from one control plane", "Self-hostable — you host it, or we do"]}
					src={`${A}/overview.jpg`}
					alt="The Alethia console overview — three multi-cloud projects on AWS, GCP, and Hetzner, with usage and recent jobs."
				/>
				<Showcase
					n="02"
					label="Design"
					title="The canvas is the design surface."
					body="Every service and dependency lives on one canvas you can see, configure, and prove. Shape each resource in place — no YAML, no separate form — and it compiles to OpenTofu with a live cost estimate."
					points={["Network, cluster, databases, caches, DNS, storage", "Configure in the node inspector, not a form", "Live Infracost estimate as you design"]}
					src={`${A}/inspector.jpg`}
					alt="The architecture canvas with a cluster node selected — configure resources in place, no YAML."
					muted
				/>
				<Showcase
					n="03"
					label="AI agent"
					title="Elench understands your infrastructure."
					body="The agent reads your projects, jobs, clusters, and costs through the same tools the console uses. Ask it anything, or have it propose an operation — but it never provisions on its own. You approve."
					points={["Ask: connectors, spend, drift, deploys", "Proposes operations — you approve", "Open to your own agents over MCP"]}
					src={`${A}/elench.jpg`}
					alt="Elench, the Alethia AI agent — ask about connectors, spend, or drift, or have it propose an operation."
				/>
				<ProveBand />
				<Showcase
					n="05"
					label="Operate"
					title="A fleet that keeps itself sized."
					body="A self-healing fleet of runners executes every plan and apply — sized to demand, replacing dead nodes, and rolling itself to new versions with zero downtime. Self-hosted in your account, or managed by us."
					points={["Warm pools sized to demand", "Zero-downtime version rollouts", "Self-hosted or managed"]}
					src={`${A}/fleet.jpg`}
					alt="The Alethia runner fleet — release versions, rollout status, and per-cloud runners."
					muted
				/>
				<PositioningBand />
				<OpenSource />
				<Enterprise />
				<RoadmapBand />
				<CTA />
			</Reveal>
			<Footer />
		</div>
	);
}
