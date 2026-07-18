// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getGitHubStars } from "@/lib/github-stars";
import { Header } from "@/components/landing/home/header";
import { Hero } from "@/components/landing/home/hero";
import { RunsOn } from "@/components/landing/home/runs-on";
import { Feature } from "@/components/landing/home/feature";
import { PositioningBand, RoadmapBand } from "@/components/landing/home/bands";
import { OpenSource } from "@/components/landing/home/open-source";
import { Enterprise } from "@/components/landing/home/enterprise";
import { CTA } from "@/components/landing/home/cta";
import { Footer } from "@/components/landing/home/footer";
import { Reveal } from "@/components/landing/home/reveal";
import { VizConnect } from "@/components/landing/home/viz/viz-connect";
import { VizPipeline } from "@/components/landing/home/viz/viz-pipeline";
import { VizCanvas } from "@/components/landing/home/viz/viz-canvas";
import { VizVerify } from "@/components/landing/home/viz/viz-verify";
import { VizFleet } from "@/components/landing/home/viz/viz-fleet";

/**
 * Alethia Labs public home page. The hero is the product video; the body is
 * bespoke animated diagrams (not screenshots) that illustrate each concept.
 */
export default async function HomePage() {
	const stars = await getGitHubStars();

	return (
		<div className="min-h-screen bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
			<Header stars={stars} />
			<Reveal>
				<Hero />
				<RunsOn />
				<Feature
					n="01"
					label="Own it"
					title="Your clouds. Your accounts. Zero stored keys."
					body="Connect AWS, Google Cloud, or Hetzner through short-lived federated identity. Alethia mints a token for each operation and holds nothing — no static credentials, on disk or in a database."
					points={["Keyless federated identity", "Multi-cloud from one control plane", "Self-hostable — you host it, or we do"]}
					visual={<VizConnect />}
				/>
				<Feature
					n="02"
					label="The spine"
					title="From a commit to a proven, running cluster."
					body="Your Project compiles to a plan, the plan is verified, the apply runs on a sandboxed runner, and ArgoCD reconciles the cluster to Git — every step streamed and audited."
					points={["Compiles to OpenTofu", "Runs sandboxed, streamed live", "GitOps reconciliation"]}
					visual={<VizPipeline />}
					reverse
				/>
				<Feature
					n="03"
					label="Design"
					title="The canvas is the design surface."
					body="Every service and dependency lives on one canvas you can see, configure, and prove — no YAML, no separate form. Shape each resource in place; it compiles down with a live cost estimate."
					points={["Network, cluster, databases, caches, DNS", "Configure in the node inspector", "Live Infracost estimate"]}
					visual={<VizCanvas />}
					muted
				/>
				<Feature
					n="04"
					label="Verification"
					title="Prove it. Then keep proving it."
					body="Between plan and apply, a deterministic gate verifies the plan — keyless, least-privilege, no public data stores, fail-closed. Every approved apply carries a signed ed25519 receipt. The LLM proposes; the gate disposes."
					points={["Fail-closed policy gate", "Signed ed25519 evidence receipt", "Drift keeps re-proving it"]}
					visual={<VizVerify />}
					reverse
				/>
				<Feature
					n="05"
					label="Operate"
					title="A fleet that keeps itself sized."
					body="A self-healing pool of runners executes every plan and apply — sized to demand, replacing dead nodes, and rolling itself to new versions with zero downtime. Self-hosted in your account, or managed by us."
					points={["Warm pools sized to demand", "Self-healing", "Zero-downtime rollouts"]}
					visual={<VizFleet />}
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
