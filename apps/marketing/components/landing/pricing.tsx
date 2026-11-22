"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { useState } from "react";
import { Button } from "@repo/ui/button";
import { Badge } from "@repo/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@repo/ui/table";
import { Accordion, AccordionContent, AccordionHeader, AccordionItem, AccordionTrigger } from "@repo/ui/accordion";
import { SegmentedControl } from "@repo/ui/segmented-control";
import { Input } from "@repo/ui/input";
import { cn } from "@repo/ui/utils";
import {
	disp,
	eyebrow,
	Icon,
	mono,
	Wrap,
} from "@repo/brand/site-primitives";
import { PageClose } from "@repo/brand/site-sections";
import {
	PLAN_CATALOG,
	type PlanId,
	type SupportedCurrency,
} from "@repo/plan-catalog";
import { splitPriceLabel } from "@/lib/billing/price-label";

/** Every "talk to us" path on the site is the one contact form. */
const CONTACT_ENTERPRISE = "/contact?topic=enterprise";
const CONTACT_DEMO = "/contact?topic=demo";

interface Cta {
	label: string;
	href: string;
	variant: "default" | "outline";
}

/**
 * One CTA per tier. Enterprise used to carry two ("Get a demo" + "Request trial"),
 * which made its column a different shape from the other two and asked the visitor
 * to choose twice. It goes to the contact form with the enterprise topic preset.
 */
function ctaFor(plan: PlanId): Cta {
	switch (plan) {
		case "community":
			return { label: "Start provisioning", href: "/signup", variant: "outline" };
		case "team":
			return {
				// Solid ink, not the retired blue. Emphasis comes from the column tint
				// and the POPULAR badge.
				label: "Start free trial",
				href: "/signup?next=%2Fstart%3Fplan%3Dteam%26trial%3D1",
				variant: "default",
			};
		case "enterprise":
			return { label: "Contact", href: CONTACT_ENTERPRISE, variant: "outline" };
		default:
			return { label: "Get started", href: "/signup", variant: "outline" };
	}
}

/* ============ Hero ============ */
/**
 * Two lines, left, and nothing else — no rail, no lede, no CTAs, no footnote.
 * The tier box is a few hundred pixels below and is the actual call to action;
 * a second one above it was competing with it.
 */
function PricingOpen() {
	return (
		<section className="pt-[112px] pb-14 max-[640px]:pt-[80px]">
			<Wrap>
				<h1
					className="vx-display-in font-grotesk text-display-md font-bold leading-display tracking-display text-text-primary"
					style={{ margin: 0, maxWidth: "16ch" }}
				>
					<span>Own your infrastructure.</span>
					<span>Pay for the convenience.</span>
				</h1>
			</Wrap>
		</section>
	);
}

/* ============ Tiers ============ */
/**
 * One column of the tier box.
 *
 * Feature rows come from `plan.included`, flattened — NOT `plan.highlights`.
 * `highlights` is 3 / 4 / 5 items across the three plans, which gives ragged
 * columns; `included` flattens to exactly 6 for Hobby and 6 for Pro, and 12 for
 * Enterprise, so one `slice` squares them off.
 *
 * The `(coming soon)` filter is load-bearing, not cosmetic. The catalog's only
 * such entry is "SCIM provisioning (coming soon)", and it sits at index 4 of
 * Enterprise — inside the slice. `apps/docs/content/docs/reference/standards/scim-saml.mdx`
 * carries an explicit "Do not represent SCIM as available" callout: there is no
 * `/scim/v2` endpoint. Without this filter the page ships it as a feature.
 */
function TierColumn({
	plan,
	priceLabel,
}: {
	plan: (typeof PLAN_CATALOG)[number];
	priceLabel: string;
}) {
	const popular = Boolean(plan.popular);
	const cta = ctaFor(plan.id);
	const { amount, suffix } = splitPriceLabel(priceLabel);
	const inheritsName = plan.inheritsFrom
		? PLAN_CATALOG.find((p) => p.id === plan.inheritsFrom)?.name
		: undefined;
	const rows = plan.included
		.flatMap((group) => group.items)
		.filter((item) => !item.includes("(coming soon)"))
		.slice(0, 6);
	return (
		<div className={cn("flex flex-col px-7 py-8", popular && "bg-surface-muted")}>
			<div className="flex items-center justify-between">
				<span style={{ ...disp, fontSize: 17, fontWeight: 600, color: "var(--text-primary)" }}>
					{plan.name}
				</span>
				{popular && (
					<Badge variant="outline" className="vx-badge-mono">
						Popular
					</Badge>
				)}
			</div>

			<div className="mt-7 flex items-baseline gap-1.5">
				<span
					className="font-grotesk font-bold tracking-display text-text-primary"
					style={{ fontSize: 44, lineHeight: 1 }}
				>
					{amount}
				</span>
				{suffix && <span className="text-[12px] text-text-tertiary">{suffix}</span>}
			</div>

			<p className="mt-5 min-h-[38px] max-w-[26ch] text-[13px] leading-[1.5] text-text-tertiary">
				{plan.tagline}
			</p>

			<hr className="my-7 border-0 border-t border-border-faint" />
			<p className="text-[12px] text-text-tertiary">
				{inheritsName ? `All ${inheritsName} features, plus:` : "Includes:"}
			</p>

			<ul className="mt-4 m-0 list-none space-y-3 p-0">
				{rows.map((row) => (
					<li key={row} className="flex items-start gap-2.5">
						<span className="mt-0.5 shrink-0 text-text-primary">
							<Icon k="check" size={14} sw={2.2} />
						</span>
						<span className="text-[13px] leading-[1.4] text-text-secondary">{row}</span>
					</li>
				))}
			</ul>

			{/* Pinned so all three CTAs share one baseline whatever the row count. */}
			<div className="mt-auto pt-9">
				<Button
					size="sm"
					variant={cta.variant}
					className="w-full"
					nativeButton={false}
					render={<Link href={cta.href} />}
				>
					{cta.label}
				</Button>
			</div>
		</div>
	);
}

/**
 * The three tiers as ONE bordered box split by vertical hairlines, rather than
 * three detached cards with a gap between them. The hairline is how every other
 * surface in this system separates things; three floating cards with their own
 * borders, shadows and raised fills were the odd one out.
 */
function TierBox({
	teamPriceLabel,
	currency,
	onCurrency,
}: {
	teamPriceLabel: string;
	currency: SupportedCurrency;
	onCurrency: (c: SupportedCurrency) => void;
}) {
	return (
		<section className="pb-[96px]">
			<Wrap>
				<div className="mb-4 flex justify-end">
					<SegmentedControl
						label="Currency"
						mono
						options={[
							{ value: "usd" as SupportedCurrency, label: "usd" },
							{ value: "eur" as SupportedCurrency, label: "eur" },
						]}
						value={currency}
						onChange={onCurrency}
					/>
				</div>
				<div style={{ border: "1px solid var(--border)", background: "var(--surface)" }}>
					<div className="grid grid-cols-1 divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
						{PLAN_CATALOG.map((plan) => (
							<TierColumn
								key={plan.id}
								plan={plan}
								priceLabel={plan.id === "team" ? teamPriceLabel : plan.priceLabel}
							/>
						))}
					</div>
				</div>
				<p className="mt-6 text-[12.5px] leading-[1.6] text-text-tertiary">
					Every plan provisions into your own cloud account. The Pro price is per seat, billed
					monthly through Stripe.
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

// Columns: Hobby (community) · Pro (id `team`) · Enterprise. Values are substantiated by
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
			// Hobby was "Self-hosted" while its CTA is the hosted signup. It is both.
			["Deployment", "Hosted · self-hosted", "Hosted", "Hosted · self-managed"],
			["Support", "Community", "Standard", "Dedicated + SLA"],
		],
	},
];

const POP_COL = 1; // Pro (id `team`), 0-based among the 3 plans

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
		<span
			className="text-[10.5px] md:text-[11.5px]"
			style={{ display: "block", textAlign: "center", ...mono, color: head ? "var(--text-primary)" : "var(--text-secondary)" }}
		>
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
 * `<table>` element in the whole marketing app. The Pro column stays tinted, and the
 * group headers keep their spacer cells so the tint runs unbroken down the column.
 */
function Matrix({ teamPriceLabel, query, onQuery }: { teamPriceLabel: string; query: string; onQuery: (q: string) => void }) {
	const q = query.trim().toLowerCase();
	const groups = q
		? MATRIX.map((g) => ({ ...g, rows: g.rows.filter((r) => r[0].toLowerCase().includes(q)) })).filter(
				(g) => g.rows.length > 0,
			)
		: MATRIX;
	const matchCount = groups.reduce((n, g) => n + g.rows.length, 0);
	const colClass = (i: number): string => (i === POP_COL ? "bg-surface-muted" : "");
	const priceFor = (id: PlanId, fallback: string): string => (id === "team" ? teamPriceLabel : fallback);
	return (
		<section style={{ padding: "72px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<h2
					className="font-grotesk text-display-sm font-bold tracking-display text-text-primary"
					style={{ margin: "0 0 24px", lineHeight: 1.05 }}
				>
					Every plan, side by side.
				</h2>
				<div className="mb-5 max-w-[300px]">
					<Input
						type="search"
						value={query}
						onChange={(e) => onQuery(e.target.value)}
						placeholder="Search features…"
						aria-label="Search features"
						className="h-9 rounded-sm border-border-strong bg-surface-sunken text-[13px]"
					/>
					{/* The count is announced rather than shown: a sighted user sees rows
					    disappear, and without this a screen-reader user gets nothing. */}
					<p aria-live="polite" className="sr-only">
						{matchCount} {matchCount === 1 ? "feature matches" : "features match"}
					</p>
				</div>
				{/* `overflow-clip`, not `overflow-hidden`: both round the corners, but
				    `hidden` makes this box a scroll container, which would trap the
				    sticky header below. `clip` does not, so the header sticks to the page. */}
				<div className="overflow-clip rounded-lg border border-border bg-surface">
					{/* No `scroll` and no min-width — that pair was the cause of both
					    scrollbars. `scroll` made the wrapper `overflow-x: auto`, which per spec
					    forces `overflow-y: auto` too, and every row's clamp marks are a box
					    `--cl-gap` outside the row, resting at `--cl-reach` scale — so the
					    wrapper overflowed on both axes and scrolled both ways even on a wide
					    screen. The default wrapper clips instead and scrolls nothing.
					    It fits a 375px phone without scrolling: below `md` the cells lose most
					    of their padding and the values drop a size, and the feature column
					    wraps — anywhere, as a last resort — so the three plan columns always
					    get their full width and none of them is clipped. */}
					<Table>
						<caption className="sr-only">
							Alethia plan comparison — features by plan
						</caption>
						{/* Sticky against the page, below the site header: the header is the
						    frame inset, a 1px top pad, a 62px row and a 1px rule. */}
						<TableHeader className="sticky top-[calc(var(--frame-inset)+64px)] z-[var(--z-sticky-head)]">
							<TableRow className="border-border bg-surface-muted hover:bg-surface-muted">
								<TableHead scope="col" className="px-2 py-4 md:px-[18px]">
									<span style={{ ...eyebrow, fontSize: 9 }}>Plan</span>
								</TableHead>
								{PLAN_CATALOG.map((p, i) => (
									<TableHead
										key={p.id}
										scope="col"
										className={cn("border-l border-border-faint px-1.5 py-3.5 text-center whitespace-normal md:px-3", colClass(i))}
									>
										<span className="text-[13px] md:text-[14px]" style={{ ...disp, fontWeight: 600, color: "var(--text-primary)" }}>
											{p.name}
										</span>
										<span style={{ ...mono, fontSize: 10, color: "var(--text-tertiary)", display: "block", marginTop: 3 }}>
											{priceFor(p.id, p.priceLabel)}
										</span>
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						{groups.map((group) => (
							<TableBody key={group.label}>
								<TableRow className="border-border-faint bg-surface-sunken hover:bg-surface-sunken">
									<TableHead scope="colgroup" className="px-2 py-2.5 whitespace-normal md:px-[18px]">
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
										<TableHead
											scope="row"
											className="px-2 py-[11px] text-[12px] font-normal whitespace-normal text-text-secondary max-md:[overflow-wrap:anywhere] md:px-[18px] md:text-[12.5px]"
										>
											{row[0]}
										</TableHead>
										{[1, 2, 3].map((c) => (
											<TableCell key={c} className={cn("border-l border-border-faint px-1.5 py-[11px] whitespace-normal md:px-3", colClass(c - 1))}>
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

/* ============ Open-core line ============ */
/**
 * One line and one link. The star button and the feature list that used to sit
 * here live on /open-source, which is where a reader who cares about them goes.
 */
function OpenCore() {
	return (
		<section className="py-14" style={{ borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<p className="m-0 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-ui-md text-text-secondary">
					<span>The single-tenant core is open source under AGPL-3.0.</span>
					<Link
						href="/open-source"
						className="vx-clamp vx-clamp--tight text-text-primary no-underline transition-colors hover:text-text-secondary"
					>
						Open source ›
					</Link>
				</p>
			</Wrap>
		</section>
	);
}

/* ============ FAQ ============ */
const FAQ: { q: string; a: string }[] = [
	{ q: "Is the free tier really free?", a: "Yes. The core is open source under AGPL-3.0, so you can self-host it in your own cloud and pay nothing." },
	{ q: "How does per-seat billing work?", a: "Pro is billed per active member of your organization, monthly through Stripe. Seats follow your team as it changes." },
	{ q: "Can I self-host the paid features?", a: "Yes, with Enterprise. It includes a self-managed license for SSO, custom roles and audit in your own environment." },
	{ q: "Do you store my cloud credentials?", a: "On AWS, GCP and Azure, no: the runner mints short-lived federated credentials per job, and no access key is written to disk or held in our database. Hetzner has no federation, so a scoped API token is stored encrypted at rest and decrypted only for the job — run a self-managed runner there and it never reaches us at all." },
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
				<h2
					className="font-grotesk text-display-sm font-bold tracking-display text-text-primary"
					style={{ margin: "0 0 24px", lineHeight: 1.05 }}
				>
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

/* ============ Close ============ */
function PricingClose() {
	return (
		<PageClose
			line="Start free. Upgrade when your team does."
			ctas={[
				{ label: "Get started", href: "/signup" },
				{ label: "Contact", href: CONTACT_DEMO, variant: "outline" },
			]}
		/>
	);
}

interface PricingProps {
	/** Pro (id `team`) per-seat label per currency, read live from Stripe (catalog fallback). */
	teamPrice: Record<SupportedCurrency, string>;
	/** Currency to show first (from the visitor's region); the toggle overrides. */
	initialCurrency: SupportedCurrency;
}

/**
 * Public pricing page body (between Header/Footer). Tiers come from PLAN_CATALOG — the
 * same source of truth as the in-app billing picker — so marketing never drifts from the
 * enforced entitlement ladder. The EUR/USD toggle (defaulted from the visitor's region)
 * switches the Pro per-seat label.
 */
export function Pricing({ teamPrice, initialCurrency }: PricingProps) {
	const [currency, setCurrency] = useState<SupportedCurrency>(initialCurrency);
	const [query, setQuery] = useState("");
	const teamPriceLabel = teamPrice[currency];
	return (
		<div id="pricing">
			<PricingOpen />
			<TierBox teamPriceLabel={teamPriceLabel} currency={currency} onCurrency={setCurrency} />
			<Matrix teamPriceLabel={teamPriceLabel} query={query} onQuery={setQuery} />
			<OpenCore />
			<Faq />
			<PricingClose />
		</div>
	);
}
