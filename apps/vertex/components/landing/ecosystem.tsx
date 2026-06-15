// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CopyButton } from "./copy-button";
import { ArrowRight, Globe, Terminal, BookOpen, GitBranch } from "lucide-react";

interface EcoCard {
	icon: React.ComponentType<{ className?: string }>;
	title: string;
	badge?: string;
	description: string;
	install?: string;
	cta?: { label: string; href: string };
}

const CARDS: EcoCard[] = [
	{
		icon: Globe,
		title: "Vertex",
		description:
			"Visual web control plane for infrastructure configuration, real-time job monitoring, and cost estimation across AWS, GCP, and Azure.",
		cta: { label: "Open Dashboard", href: "/dashboard" },
	},
	{
		icon: Terminal,
		title: "Grape CLI",
		description:
			"Interactive terminal with TUI wizards for infrastructure design, provisioning, and teardown. Headless worker mode for CI/CD.",
		install: "brew install grape",
	},
	{
		icon: BookOpen,
		title: "Vintner",
		description:
			"Complete documentation — CLI reference, platform guides, architecture overview, and API documentation.",
		cta: { label: "Read the Docs", href: "/docs" },
	},
	{
		icon: GitBranch,
		title: "ArgoCD",
		badge: "Bootstrapped",
		description:
			"GitOps reconciler installed automatically on every cluster. Git as source of truth with automatic drift detection.",
		cta: { label: "Learn More", href: "/docs" },
	},
];

export function Ecosystem() {
	return (
		<section id="ecosystem" className="py-24 md:py-32">
			<div className="container mx-auto px-4">
				<div className="max-w-[64rem] mx-auto">
					<h2 className="font-bold text-3xl md:text-4xl tracking-tighter text-foreground mb-4">
						The Vertex Ecosystem
					</h2>
					<p className="text-muted-foreground text-base leading-relaxed mb-12 max-w-[40rem]">
						Four components that work together — a web dashboard, a CLI,
						documentation, and GitOps reconciliation.
					</p>

					<div className="grid sm:grid-cols-2 gap-4">
						{CARDS.map((card) => (
							<div
								key={card.title}
								className="group rounded-xl border border-border/50 bg-card/50 p-6 transition-colors hover:border-border hover:bg-card"
							>
								<div className="flex items-start gap-3 mb-3">
									<div className="rounded-lg bg-muted/50 p-2">
										<card.icon className="h-4 w-4 text-foreground" />
									</div>
									<div className="flex items-center gap-2 mt-1.5">
										<h3 className="text-sm font-semibold text-foreground">
											{card.title}
										</h3>
										{card.badge && (
											<span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
												{card.badge}
											</span>
										)}
									</div>
								</div>

								<p className="text-sm text-muted-foreground leading-relaxed mb-4">
									{card.description}
								</p>

								{card.install && (
									<div className="flex items-center gap-2 rounded-md border border-border/50 bg-neutral-950 px-3 py-2 font-mono text-xs">
										<span className="text-white/80 flex-1">
											{card.install}
										</span>
										<CopyButton text={card.install} />
									</div>
								)}

								{card.cta && (
									<a
										href={card.cta.href}
										className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
									>
										{card.cta.label}
										<ArrowRight className="h-3.5 w-3.5" />
									</a>
								)}
							</div>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
