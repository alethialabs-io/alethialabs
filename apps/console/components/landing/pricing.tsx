// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	ArrowRight,
	Boxes,
	Check,
	Fingerprint,
	KeyRound,
	type LucideIcon,
	LifeBuoy,
	ScrollText,
	Shield,
	ShieldCheck,
	Users,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PLAN_CATALOG } from "@/lib/billing/plan-catalog";
import type { BillingPlan } from "@/lib/db/schema/enums";
import { cn } from "@/lib/utils";

/**
 * Icon per "What's included" group label — mirrors the in-app PlanChooser so the
 * public pricing page and the settings billing flow read the same.
 */
const GROUP_ICON: Record<string, LucideIcon> = {
	Platform: Boxes,
	Access: KeyRound,
	Collaboration: Users,
	Governance: ShieldCheck,
	Compliance: ScrollText,
	Identity: Fingerprint,
	"Security & compliance": Shield,
	Support: LifeBuoy,
};

/** Enterprise talks to sales; the rest start in the app. */
function ctaFor(plan: BillingPlan): { label: string; href: string } {
	if (plan === "enterprise") {
		return { label: "Talk to sales", href: "mailto:sales@alethialabs.io" };
	}
	return { label: "Get Started", href: "/auth/signin" };
}

/**
 * Public pricing section. Renders the four tiers straight from PLAN_CATALOG — the same
 * display source of truth the in-app billing picker uses — so marketing copy can never
 * drift from the enforced entitlement ladder. Purely presentational; CTAs are plain
 * links (no auth/checkout flow on the public page).
 */
export function Pricing() {
	return (
		<section id="pricing" className="py-24 md:py-32">
			<div className="container mx-auto px-4">
				<div className="text-center mb-14">
					<h2 className="font-bold text-3xl md:text-4xl tracking-tighter text-foreground mb-4">
						Simple, predictable pricing
					</h2>
					<p className="text-muted-foreground max-w-[40rem] mx-auto">
						Start free with your own Zones &amp; Specs. Upgrade when your
						team needs to collaborate, govern, and scale. You only ever pay
						your own cloud providers for the infrastructure you provision.
					</p>
				</div>

				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 max-w-[80rem] mx-auto">
					{PLAN_CATALOG.map((plan) => {
						const cta = ctaFor(plan.id);
						return (
							<div
								key={plan.id}
								className={cn(
									"flex flex-col rounded-xl border bg-card/50 p-6 transition-colors hover:bg-card",
									plan.popular
										? "border-foreground/30"
										: "border-border/50 hover:border-border",
								)}
							>
								<div className="flex items-center justify-between gap-2 mb-1">
									<h3 className="text-sm font-semibold text-foreground">
										{plan.name}
									</h3>
									{plan.popular && (
										<Badge
											variant="outline"
											className="text-[10px] uppercase tracking-wider"
										>
											Most popular
										</Badge>
									)}
								</div>
								<p className="text-2xl font-bold tracking-tight text-foreground">
									{plan.priceLabel}
								</p>
								<p className="text-xs text-muted-foreground mt-1 min-h-[2rem]">
									{plan.tagline}
								</p>

								<Button
									asChild
									variant={plan.popular ? "default" : "outline"}
									className="gap-2 mt-5 w-full"
								>
									<Link href={cta.href}>
										{cta.label}
										<ArrowRight className="h-4 w-4" />
									</Link>
								</Button>

								<div className="mt-6 space-y-4 border-t border-border/40 pt-5">
									{plan.included.map((group) => {
										const Icon = GROUP_ICON[group.label];
										return (
											<div key={group.label}>
												<div className="flex items-center gap-1.5 mb-2">
													{Icon && (
														<Icon className="h-3.5 w-3.5 text-muted-foreground" />
													)}
													<span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
														{group.label}
													</span>
												</div>
												<ul className="space-y-1.5">
													{group.items.map((item) => (
														<li
															key={item}
															className="flex items-start gap-2 text-xs text-muted-foreground leading-relaxed"
														>
															<Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" />
															<span>{item}</span>
														</li>
													))}
												</ul>
											</div>
										);
									})}
								</div>
							</div>
						);
					})}
				</div>

				<p className="text-center text-xs text-muted-foreground mt-10">
					Prices shown are indicative. Final amounts and currency are
					confirmed at checkout.
				</p>
			</div>
		</section>
	);
}
