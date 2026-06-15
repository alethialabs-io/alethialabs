// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@/components/ui/button";
import { CopyButton } from "./copy-button";
import { ArrowRight } from "lucide-react";
import Link from "next/link";

interface Recipe {
	title: string;
	description: string;
	href: string;
}

const RECIPES: Recipe[] = [
	{
		title: "Production EKS",
		description:
			"Full AWS stack: VPC, EKS with Karpenter, Aurora PostgreSQL, ElastiCache, ArgoCD.",
		href: "/auth/signin",
	},
	{
		title: "GKE + Cloud SQL",
		description:
			"Google Cloud: GKE Autopilot, Cloud SQL, Memorystore, Cloud DNS.",
		href: "/auth/signin",
	},
	{
		title: "AKS + Azure Database",
		description:
			"Azure stack: AKS, Azure Database for PostgreSQL, Azure Cache, Key Vault.",
		href: "/auth/signin",
	},
];

export function GetStarted() {
	return (
		<section id="cli" className="py-24 md:py-32">
			<div className="container mx-auto px-4">
				<div className="max-w-[64rem] mx-auto">
					<div className="text-center mb-12">
						<h2 className="font-bold text-3xl md:text-4xl tracking-tighter text-foreground mb-4">
							Start building in minutes
						</h2>

						<div className="flex flex-col sm:flex-row items-center justify-center gap-4 mt-8">
							<Link href="/docs">
								<Button size="lg" className="gap-2 h-12 px-8">
									Read the Docs
									<ArrowRight className="h-4 w-4" />
								</Button>
							</Link>
							<div className="flex items-center gap-2 rounded-lg border border-border/50 bg-neutral-950 px-4 py-2.5">
								<code className="font-mono text-sm text-white/80">
									<span className="text-white/30">$ </span>
									brew install grape
								</code>
								<CopyButton text="brew install grape" />
							</div>
						</div>
					</div>

					{/* Recipe cards */}
					<div className="grid sm:grid-cols-3 gap-4 mt-12">
						{RECIPES.map((recipe) => (
							<div
								key={recipe.title}
								className="rounded-xl border border-border/50 bg-card/50 p-5 transition-colors hover:border-border hover:bg-card"
							>
								<h3 className="text-sm font-semibold text-foreground mb-2">
									{recipe.title}
								</h3>
								<p className="text-xs text-muted-foreground leading-relaxed mb-4">
									{recipe.description}
								</p>
								<Link
									href={recipe.href}
									className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
								>
									Get Started
									<ArrowRight className="h-3 w-3" />
								</Link>
							</div>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
