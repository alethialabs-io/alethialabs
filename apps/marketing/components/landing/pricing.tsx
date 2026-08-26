"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { useState } from "react";
import { Button } from "@repo/ui/button";
import { Badge } from "@repo/ui/badge";
import { Card } from "@repo/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@repo/ui/table";
import { Accordion, AccordionContent, AccordionHeader, AccordionItem, AccordionTrigger } from "@repo/ui/accordion";
import { SegmentedControl } from "@repo/ui/segmented-control";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { cn } from "@repo/ui/utils";
import {
	disp,
	eyebrow,
	Icon,
	Mark,
	mono,
	Wrap,
} from "@repo/brand/site-primitives";
import { PageCTA, PageHero, SectionMark } from "@repo/brand/site-sections";
import {
	PLAN_CATALOG,
	type PlanId,
	type SupportedCurrency,
} from "@repo/plan-catalog";

const SALES = "/contact/sales";

interface Cta {
	label: string;
	href: string;
	variant: "default" | "outline";
}

/**
 * CTA(s) per tier. Hobby drops into the app; Team starts a one-month trial via the
 * /start intent carrier; Enterprise is contact-only (demo + self-serve trial).
 */
function ctasFor(plan: PlanId): Cta[] {
	switch (plan) {
		case "community":
			return [{ label: "Start provisioning", href: "/signup", variant: "outline" }];
		case "team":
			return [
				{
					// Solid ink, not the retired blue. Emphasis comes from the card —
					// raised surface, stronger border, shadow and the POPULAR badge.
					label: "Start free trial",
					href: "/signup?next=%2Fstart%3Fplan%3Dteam%26trial%3D1",
					variant: "default",
				},
			];
		case "enterprise":
			return [
				{ label: "Get a demo", href: SALES, variant: "outline" },
				{ label: "Request trial", href: "/contact/enterprise", variant: "outline" },
			];
		default:
			return [{ label: "Get started", href: "/signup", variant: "outline" }];
	}
}

/* ============ Hero ============ */
/** Pricing hero. The composition lives in @repo/brand — /enterprise and this page
 *  were building the identical hero by hand, down to the letter-spacing. */
function PricingHero() {
	return (
		<PageHero
			kicker="alethia · pricing"
			status="open core"
			headline={{ lead: "Own your infrastructure.", muted: "Pay for the convenience." }}
			lede="The core is open source and free to self-host. Hosted plans add organizations, governance, and SSO — billed for the convenience, never for the cloud you already pay for."
			ledeMaxWidth={600}
			ctas={[
				{ label: "Get started", href: "/signup", icon: "arrow" },
				{ label: "Read the docs", href: "/docs", variant: "outline", icon: "book", iconBefore: true },
			]}
			footnote="Self-hosting the open-source core is free forever"
			paddingTop={96}
			paddingBottom={28}
		/>
	);
}

/* ============ Plan cards (equal height) ============ */
/** A single plan card. `h-full` + the stretch grid below keep all cards equal height. */
function PlanCard({ plan, priceLabel }: { plan: (typeof PLAN_CATALOG)[number]; priceLabel: string }) {
	const popular = Boolean(plan.popular);
	const ctas = ctasFor(plan.id);
	// "Everything in {previous tier}, plus:" lead-in over the feature list (Vercel-style),
	// derived from the entitlement ladder. The base tier has no parent → "Includes:".
	const inheritsName = plan.inheritsFrom
		? PLAN_CATALOG.find((p) => p.id === plan.inheritsFrom)?.name
		: undefined;
	const featuresLead = inheritsName ? `Everything in ${inheritsName}, plus:` : "Includes:";
	return (
		<Card
			className={cn(
				"relative h-full gap-0 rounded-lg px-5 py-[22px]",
				popular ? "border-border-strong bg-surface-raised shadow-md" : "border-border bg-surface shadow-none",
			)}
		>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
				<span style={{ ...disp, fontSize: 17, fontWeight: 600, color: "var(--text-primary)" }}>{plan.name}</span>
				{popular && (
					<Badge variant="outline" className="vx-badge-mono">
						Popular
					</Badge>
				)}
			</div>
			<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", margin: "0 0 16px", lineHeight: 1.45, minHeight: 34 }}>{plan.tagline}</p>
			<div style={{ ...disp, fontSize: 28, fontWeight: 600, letterSpacing: "-0.03em", color: "var(--text-primary)", lineHeight: 1.1, marginBottom: 18 }}>
				{priceLabel}
			</div>
			<div style={{ ...eyebrow, fontSize: 10, color: "var(--text-tertiary)", marginBottom: 12 }}>{featuresLead}</div>
			<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
				{plan.highlights.map((h) => (
					<div key={h} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
						<span style={{ color: "var(--text-primary)", marginTop: 1, flexShrink: 0 }}><Icon k="check" size={14} sw={2.2} /></span>
						<span style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.4 }}>{h}</span>
					</div>
				))}
			</div>
			{/* Pinned to the card bottom so every plan's CTA(s) share one baseline, regardless
			    of how many features or buttons the card has. */}
			<div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: "auto", paddingTop: 24 }}>
				{ctas.map((cta) => (
					<Button key={cta.label} variant={cta.variant} size="sm" className="w-full" nativeButton={false} render={<Link href={cta.href} />}>
						{cta.label}<Icon k="arrow" size={14} />
					</Button>
				))}
			</div>
		</Card>
	);
}

/** The three plan cards in an equal-height (stretch) grid. */
function PlanCards({ teamPriceLabel }: { teamPriceLabel: string }) {
	return (
		<section style={{ padding: "20px 0 8px" }}>
			<Wrap>
				<div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, alignItems: "stretch" }} className="ah-3col">
					{PLAN_CATALOG.map((plan) => (
						<PlanCard
							key={plan.id}
							plan={plan}
							priceLabel={plan.id === "team" ? teamPriceLabel : plan.priceLabel}
						/>
					))}
				</div>
				<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", textAlign: "center", margin: "22px 0 0", lineHeight: 1.6 }}>
					All plans include multi-cloud provisioning, the Project designer, GitOps, the AI agent, and zero stored credentials. The Team price is per seat, billed monthly through Stripe.
				</p>
			</Wrap>
		</section>
	);
}

/* ============ Comparison matrix (verified rows only) ============ */
type MatrixValue = boolean | string;
interface MatrixGroup {
	label: string;
	rows: [string, MatrixValue, MatrixValue, MatrixValue][];
}

// Columns: Hobby (community) · Team · Enterprise. Values are substantiated by
// PLAN_CATALOG.included + enforced entitlements (plan_max_concurrency = 2/8/∞).
const MATRIX: MatrixGroup[] = [
	{
		label: "Platform",
		rows: [
			["Multi-cloud provisioning", true, true, true],
			["Project designer — form + canvas", true, true, true],
			["GitOps (ArgoCD)", true, true, true],
			["Zero-trust cloud connections", true, true, true],
			["Projects", "Unlimited", "Unlimited", "Unlimited"],
		],
	},
	{
		label: "Collaboration & governance",
		rows: [
			["Organizations & teams", false, true, true],
			["Built-in roles", true, true, true],
			["Custom roles — granular RBAC", false, false, true],
			["Audit log + export", false, false, true],
			["SSO / SAML", false, false, true],
		],
	},
	{
		label: "Scale",
		rows: [["Concurrent jobs", "2", "8", "Unlimited"]],
	},
	{
		label: "AI",
		rows: [["AI agent + repo scanner", true, true, true]],
	},
	{
		label: "Support & deployment",
		rows: [
			["Deployment", "Self-hosted", "Hosted", "Hosted · self-managed"],
			["Support", "Community", "Standard", "Dedicated + SLA"],
		],
	},
];

const POP_COL = 1; // Team, 0-based among the 3 plans

/** One matrix cell — check / dash / text. */
function MatrixCell({ value, head }: { value: MatrixValue; head: boolean }) {
	if (value === true) {
		return (
			<span style={{ display: "grid", placeItems: "center", color: "var(--text-primary)" }}>
				<Icon k="check" size={15} sw={2.2} />
			</span>
		);
	}
	if (value === false || value === "—") {
		return <span style={{ display: "block", textAlign: "center", color: "var(--text-disabled)", fontSize: 14 }}>—</span>;
	}
	return (
		<span style={{ display: "block", textAlign: "center", ...mono, fontSize: 11.5, color: head ? "var(--text-primary)" : "var(--text-secondary)" }}>
			{value}
		</span>
	);
}

/**
 * Plan comparison, as a real table.
 *
 * It was a stack of nested `display:grid` divs — no `<table>`, no `<th scope>`, no
 * row/column association — so a screen reader was handed an undifferentiated run of
 * text with no way to tell which cell belonged to which plan. There was not a single
 * `<table>` element in the whole marketing app. The Team column stays tinted, and the
 * group headers keep their spacer cells so the tint runs unbroken down the column.
 */
function Matrix({ teamPriceLabel }: { teamPriceLabel: string }) {
	const colClass = (i: number): string => (i === POP_COL ? "bg-surface-muted" : "");
	const priceFor = (id: PlanId, fallback: string): string => (id === "team" ? teamPriceLabel : fallback);
	return (
		<section style={{ padding: "72px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<SectionMark n="—" label="Compare plans" />
				<h2 style={{ ...disp, fontSize: 32, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 28px", color: "var(--text-primary)" }}>
					Every plan, side by side.
				</h2>
				<div className="overflow-hidden rounded-lg border border-border bg-surface">
					<Table className="min-w-[720px]">
						<caption className="sr-only">
							Alethia plan comparison — features by plan
						</caption>
						<TableHeader>
							<TableRow className="border-border bg-surface-muted hover:bg-surface-muted">
								<TableHead scope="col" className="px-[18px] py-4">
									<span style={{ ...eyebrow, fontSize: 9 }}>Plan</span>
								</TableHead>
								{PLAN_CATALOG.map((p, i) => (
									<TableHead
										key={p.id}
										scope="col"
										className={cn("border-l border-border-faint px-3 py-3.5 text-center", colClass(i))}
									>
										<span style={{ ...disp, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{p.name}</span>
										<span style={{ ...mono, fontSize: 10, color: "var(--text-tertiary)", display: "block", marginTop: 3 }}>
											{priceFor(p.id, p.priceLabel)}
										</span>
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						{MATRIX.map((group) => (
							<TableBody key={group.label}>
								<TableRow className="border-border-faint bg-surface-sunken hover:bg-surface-sunken">
									<TableHead scope="colgroup" className="px-[18px] py-2.5">
										<span style={{ ...eyebrow, fontSize: 9 }}>{group.label}</span>
									</TableHead>
									{/* Spacer cells, not a colspan: the popular column's tint has to
									    run through the group header or it breaks into stripes. */}
									{PLAN_CATALOG.map((p, i) => (
										<td key={p.id} className={cn("border-l border-border-faint", colClass(i))} />
									))}
								</TableRow>
								{group.rows.map((row) => (
									<TableRow key={row[0]} className="border-border-faint">
										<TableHead scope="row" className="px-[18px] py-[11px] text-[12.5px] font-normal text-text-secondary">
											{row[0]}
										</TableHead>
										{[1, 2, 3].map((c) => (
											<TableCell key={c} className={cn("border-l border-border-faint px-3 py-[11px]", colClass(c - 1))}>
												<MatrixCell value={row[c as 1 | 2 | 3]} head={c - 1 === POP_COL} />
											</TableCell>
										))}
									</TableRow>
								))}
							</TableBody>
						))}
					</Table>
				</div>
			</Wrap>
		</section>
	);
}

/* ============ Open-core band ============ */
/** Open-core messaging — free, self-hostable, AGPL. */
function OpenCore() {
	return (
		<section style={{ padding: "72px 0", borderTop: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", padding: "40px 36px", display: "grid", gridTemplateColumns: "1fr auto", gap: 32, alignItems: "center" }} className="ah-surface">
					<div>
						<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, color: "var(--text-primary)" }}>
							<Mark size={26} /><span style={{ ...eyebrow }}>Open core</span>
						</div>
						<h2 style={{ ...disp, fontSize: 30, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 12px", color: "var(--text-primary)" }}>
							Free forever. Run it in your own cloud.
						</h2>
						<p style={{ fontSize: 15, color: "var(--text-tertiary)", lineHeight: 1.6, margin: 0, maxWidth: 620 }}>
							The complete single-tenant product is open source under AGPL-3.0 — full provisioning, the Project designer, GitOps, the AI agent, and community RBAC. The paid tiers add multi-member organizations, SSO, custom roles, and audit export. No cloud credentials ever leave your control.
						</p>
					</div>
					<div style={{ display: "flex", flexDirection: "column", gap: 10 }} className="ah-hide-sm">
						<Button variant="outline" nativeButton={false} render={<a href="https://github.com/alethialabs-io/alethialabs" target="_blank" rel="noopener noreferrer" />}>
							<ProviderIcon provider="github" size={15} />Star on GitHub
						</Button>
						<Button variant="outline" nativeButton={false} render={<Link href="/docs" />}>
							<Icon k="book" size={15} />Read the docs
						</Button>
					</div>
				</div>
			</Wrap>
		</section>
	);
}

/* ============ FAQ ============ */
const FAQ: { q: string; a: string }[] = [
	{ q: "Is the free tier really free?", a: "Yes. The core is open source under AGPL-3.0 — self-host it in your own cloud and pay nothing. It's a management layer over infrastructure you already own." },
	{ q: "How does per-seat billing work?", a: "Team is billed per active member of your organization, monthly through Stripe. Add or remove seats as your team changes." },
	{ q: "Can I self-host the paid features?", a: "Enterprise includes a self-managed license, so you can run the full governance feature set — SSO, custom roles, audit — in your own environment." },
	{ q: "Do you store my cloud credentials?", a: "No. Every cloud connects through short-lived federated identity; no access keys are written to disk or held in our database, on any plan." },
];

/**
 * Pricing FAQ.
 *
 * Was a static two-column grid with every answer always open — not a disclosure at
 * all, despite reading as one. It is a real accordion now, with the first question
 * open so the section still says something at a glance. The trigger holds its clamp
 * while its panel is open, straight off base-ui's `data-panel-open`.
 */
function Faq() {
	return (
		<section style={{ padding: "72px 0", borderTop: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<SectionMark n="—" label="FAQ" />
				<h2 style={{ ...disp, fontSize: 32, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 28px", color: "var(--text-primary)" }}>
					Questions, answered.
				</h2>
				<Accordion
					defaultValue={[FAQ[0]?.q ?? ""]}
					className="overflow-hidden rounded-lg border border-border bg-surface"
				>
					{FAQ.map((item) => (
						<AccordionItem key={item.q} value={item.q} className="border-b border-border-faint last:border-b-0">
							<AccordionHeader>
								<AccordionTrigger className="group flex w-full items-center justify-between gap-6 px-[22px] py-5 text-left">
									<span style={{ ...disp, fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>{item.q}</span>
									<span className="shrink-0 text-text-tertiary transition-transform duration-[var(--dur-2)] ease-[var(--ease)] group-data-[panel-open]:rotate-180">
										<Icon k="chev" size={15} />
									</span>
								</AccordionTrigger>
							</AccordionHeader>
							<AccordionContent>
								<p style={{ fontSize: 13.5, color: "var(--text-tertiary)", margin: 0, padding: "0 22px 20px", lineHeight: 1.6, maxWidth: 720 }}>
									{item.a}
								</p>
							</AccordionContent>
						</AccordionItem>
					))}
				</Accordion>
			</Wrap>
		</section>
	);
}

/* ============ CTA ============ */
/** Closing CTA. The composition is shared — three pages were building it by hand. */
function PricingCTA() {
	return (
		<PageCTA
			headline="Start free. Upgrade when your team does."
			lede="Self-host the open core today, or spin up a hosted organization in minutes."
			ctas={[
				{ label: "Get started", href: "/signup", icon: "arrow" },
				{ label: "Contact sales", href: SALES, variant: "outline" },
			]}
		/>
	);
}

interface PricingProps {
	/** Team per-seat label per currency, read live from Stripe (catalog fallback). */
	teamPrice: Record<SupportedCurrency, string>;
	/** Currency to show first (from the visitor's region); the toggle overrides. */
	initialCurrency: SupportedCurrency;
}

/** A small USD/EUR segmented toggle for the pricing page. */
/**
 * Public pricing page body (between Header/Footer). Tiers come from PLAN_CATALOG — the
 * same source of truth as the in-app billing picker — so marketing never drifts from the
 * enforced entitlement ladder. The EUR/USD toggle (defaulted from the visitor's region)
 * switches the Team per-seat label.
 */
export function Pricing({ teamPrice, initialCurrency }: PricingProps) {
	const [currency, setCurrency] = useState<SupportedCurrency>(initialCurrency);
	const teamPriceLabel = teamPrice[currency];
	return (
		<div id="pricing">
			<PricingHero />
			<div className="mx-auto flex w-full max-w-6xl justify-end px-6">
				<SegmentedControl
					label="Currency"
					mono
					options={[
						{ value: "usd" as SupportedCurrency, label: "usd" },
						{ value: "eur" as SupportedCurrency, label: "eur" },
					]}
					value={currency}
					onChange={setCurrency}
				/>
			</div>
			<PlanCards teamPriceLabel={teamPriceLabel} />
			<Matrix teamPriceLabel={teamPriceLabel} />
			<OpenCore />
			<Faq />
			<PricingCTA />
		</div>
	);
}
