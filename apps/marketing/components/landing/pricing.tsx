"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { useState } from "react";
import { Button } from "@repo/ui/button";
import { Badge } from "@repo/ui/badge";
import { ProviderIcon } from "@repo/ui/provider-icon";
import { cn } from "@repo/ui/utils";
import {
	disp,
	eyebrow,
	HeroRail,
	Icon,
	Mark,
	mono,
	SecMark,
	Wrap,
} from "@/components/landing/home/primitives";
import {
	PLAN_CATALOG,
	type PlanId,
	type SupportedCurrency,
} from "@repo/plan-catalog";

const SALES = "/contact/sales";

interface Cta {
	label: string;
	href: string;
	variant: "default" | "outline" | "cta";
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
					label: "Start free trial",
					href: "/signup?next=%2Fstart%3Fplan%3Dteam%26trial%3D1",
					variant: "cta",
				},
			];
		case "enterprise":
			return [
				{ label: "Get a demo", href: SALES, variant: "default" },
				{ label: "Request trial", href: "/contact/enterprise", variant: "outline" },
			];
		default:
			return [{ label: "Get started", href: "/signup", variant: "outline" }];
	}
}

/* ============ Hero ============ */
/** Pricing hero — grid backdrop, headline, dual CTAs. */
function PricingHero() {
	return (
		<section style={{ position: "relative", paddingTop: 96, paddingBottom: 28, overflow: "hidden" }}>
			<div className="ah-grid-bg" />
			<Wrap style={{ position: "relative", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
				<HeroRail kicker="alethia · pricing" status="open core" maxWidth={560} />
				<h1 className="ah-h1" style={{ ...disp, fontSize: 56, fontWeight: 600, letterSpacing: "-0.045em", lineHeight: 1.04, margin: 0, maxWidth: 820, color: "var(--text-primary)" }}>
					Own your infrastructure.<br />
					<span style={{ color: "var(--text-tertiary)" }}>Pay for the convenience.</span>
				</h1>
				<p style={{ fontSize: 17.5, color: "var(--text-secondary)", maxWidth: 600, margin: "22px 0 30px", lineHeight: 1.55 }}>
					The core is open source and free to self-host. Hosted plans add organizations, governance, and SSO — billed for the convenience, never for the cloud you already pay for.
				</p>
				<div style={{ display: "flex", alignItems: "center", gap: 13, flexWrap: "wrap", justifyContent: "center" }}>
					<Link href="/signup"><Button>Get started <Icon k="arrow" size={15} /></Button></Link>
					<Link href="/docs"><Button variant="outline"><Icon k="book" size={15} />Read the docs</Button></Link>
				</div>
				<p style={{ ...mono, fontSize: 11, color: "var(--text-disabled)", letterSpacing: "0.04em", margin: "20px 0 0" }}>
					Self-hosting the open-source core is free forever
				</p>
			</Wrap>
		</section>
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
		<div
			style={{
				position: "relative",
				display: "flex",
				flexDirection: "column",
				height: "100%",
				border: "1px solid " + (popular ? "var(--border-strong)" : "var(--border)"),
				borderRadius: "var(--radius-lg)",
				background: popular ? "var(--surface-raised)" : "var(--surface)",
				boxShadow: popular ? "var(--shadow-md)" : "none",
				padding: "22px 20px",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
				<span style={{ ...disp, fontSize: 17, fontWeight: 600, color: "var(--text-primary)" }}>{plan.name}</span>
				{popular && (
					<Badge variant="outline" className="rounded-sm font-mono text-[10px] uppercase tracking-wider text-text-tertiary">
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
		</div>
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

const MATRIX_COLS = "minmax(200px, 1.6fr) repeat(3, 1fr)";
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

/** Vercel-style plan comparison table; the Team column is tinted as popular. */
function Matrix({ teamPriceLabel }: { teamPriceLabel: string }) {
	const colBg = (i: number): string => (i === POP_COL ? "var(--surface-muted)" : "transparent");
	const priceFor = (id: PlanId, fallback: string): string => (id === "team" ? teamPriceLabel : fallback);
	return (
		<section style={{ padding: "72px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="—" label="Compare plans" />
				<h2 style={{ ...disp, fontSize: 32, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 28px", color: "var(--text-primary)" }}>
					Every plan, side by side.
				</h2>
				<div style={{ overflowX: "auto" }}>
					<div style={{ minWidth: 720, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden", background: "var(--surface)" }}>
						{/* header */}
						<div style={{ display: "grid", gridTemplateColumns: MATRIX_COLS, borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
							<div style={{ padding: "16px 18px" }}><span style={{ ...eyebrow, fontSize: 9 }}>Plan</span></div>
							{PLAN_CATALOG.map((p, i) => (
								<div key={p.id} style={{ padding: "14px 12px", textAlign: "center", background: colBg(i), borderLeft: "1px solid var(--border-faint)" }}>
									<div style={{ ...disp, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{p.name}</div>
									<div style={{ ...mono, fontSize: 10, color: "var(--text-tertiary)", marginTop: 3 }}>{priceFor(p.id, p.priceLabel)}</div>
								</div>
							))}
						</div>
						{/* groups */}
						{MATRIX.map((group, gi) => (
							<div key={group.label}>
								<div style={{ display: "grid", gridTemplateColumns: MATRIX_COLS, background: "var(--surface-sunken)", borderBottom: "1px solid var(--border-faint)", borderTop: gi ? "1px solid var(--border)" : "none" }}>
									<div style={{ padding: "10px 18px" }}><span style={{ ...eyebrow, fontSize: 9 }}>{group.label}</span></div>
									{PLAN_CATALOG.map((p, i) => (
										<div key={p.id} style={{ background: colBg(i), borderLeft: "1px solid var(--border-faint)" }} />
									))}
								</div>
								{group.rows.map((row, ri) => (
									<div key={row[0]} style={{ display: "grid", gridTemplateColumns: MATRIX_COLS, alignItems: "center", borderBottom: ri < group.rows.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
										<div style={{ padding: "11px 18px", fontSize: 12.5, color: "var(--text-secondary)" }}>{row[0]}</div>
										{[1, 2, 3].map((c) => (
											<div key={c} style={{ padding: "11px 12px", background: colBg(c - 1), borderLeft: "1px solid var(--border-faint)", alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center" }}>
												<MatrixCell value={row[c as 1 | 2 | 3]} head={c - 1 === POP_COL} />
											</div>
										))}
									</div>
								))}
							</div>
						))}
					</div>
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

/** Pricing FAQ — verifiable answers only. */
function Faq() {
	return (
		<section style={{ padding: "72px 0", borderTop: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<SecMark n="—" label="FAQ" />
				<h2 style={{ ...disp, fontSize: 32, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 28px", color: "var(--text-primary)" }}>
					Questions, answered.
				</h2>
				<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden", background: "var(--surface)" }}>
					{FAQ.map((item, i) => (
						<div key={item.q} style={{ display: "grid", gridTemplateColumns: "minmax(220px, 0.9fr) 1.6fr", gap: 24, padding: "20px 22px", borderBottom: i < FAQ.length - 1 ? "1px solid var(--border-faint)" : "none" }} className="ah-2col">
							<h3 style={{ ...disp, fontSize: 15, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>{item.q}</h3>
							<p style={{ fontSize: 13.5, color: "var(--text-tertiary)", margin: 0, lineHeight: 1.6 }}>{item.a}</p>
						</div>
					))}
				</div>
			</Wrap>
		</section>
	);
}

/* ============ CTA ============ */
/** Closing CTA — grid backdrop + dual actions. */
function PricingCTA() {
	return (
		<section style={{ padding: "92px 0", borderTop: "1px solid var(--border)", position: "relative", overflow: "hidden" }}>
			<div className="ah-grid-bg ah-grid-cta" />
			<Wrap style={{ position: "relative", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
				<span style={{ color: "var(--text-primary)" }}><Mark size={32} /></span>
				<h2 style={{ ...disp, fontSize: 40, fontWeight: 600, letterSpacing: "-0.04em", margin: "20px 0 14px", maxWidth: 600, color: "var(--text-primary)", lineHeight: 1.06 }}>
					Start free. Upgrade when your team does.
				</h2>
				<p style={{ fontSize: 16.5, color: "var(--text-secondary)", maxWidth: 500, margin: "0 0 30px", lineHeight: 1.55 }}>
					Self-host the open core today, or spin up a hosted organization in minutes.
				</p>
				<div style={{ display: "flex", gap: 13, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
					<Link href="/signup"><Button>Get started <Icon k="arrow" size={15} /></Button></Link>
					<Link href={SALES}><Button variant="outline">Contact sales</Button></Link>
				</div>
			</Wrap>
		</section>
	);
}

interface PricingProps {
	/** Team per-seat label per currency, read live from Stripe (catalog fallback). */
	teamPrice: Record<SupportedCurrency, string>;
	/** Currency to show first (from the visitor's region); the toggle overrides. */
	initialCurrency: SupportedCurrency;
}

/** A small USD/EUR segmented toggle for the pricing page. */
function CurrencyToggle({
	value,
	onChange,
}: {
	value: SupportedCurrency;
	onChange: (c: SupportedCurrency) => void;
}) {
	return (
		<div
			role="group"
			aria-label="Currency"
			className="inline-flex items-center rounded-md border border-border bg-surface-sunken p-0.5"
			style={mono}
		>
			{(["usd", "eur"] as const).map((c) => (
				<button
					key={c}
					type="button"
					aria-pressed={value === c}
					onClick={() => onChange(c)}
					className={cn(
						"rounded px-2.5 py-1 text-[11px] uppercase tracking-wide transition-colors",
						value === c
							? "bg-surface text-text-primary shadow-sm"
							: "text-text-secondary hover:text-text-primary",
					)}
				>
					{c}
				</button>
			))}
		</div>
	);
}

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
				<CurrencyToggle value={currency} onChange={setCurrency} />
			</div>
			<PlanCards teamPriceLabel={teamPriceLabel} />
			<Matrix teamPriceLabel={teamPriceLabel} />
			<OpenCore />
			<Faq />
			<PricingCTA />
		</div>
	);
}
