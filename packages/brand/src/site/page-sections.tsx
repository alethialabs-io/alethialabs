// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Button } from "@repo/ui/button";
import { PROVIDER_LABELS, ProviderIcon, type Provider } from "@repo/ui/provider-icon";

import { AlethiaMark } from "../lockup";
import { disp, eyebrow, HeroRail, Icon, type IconKey, mono, Wrap } from "./primitives";

/**
 * The two compositions every marketing page was already building by hand.
 *
 * `/enterprise` and `/pricing` did not merely look alike — they were the SAME
 * component written twice, down to `letterSpacing: "-0.045em"` and `gap: 13`.
 * `/open-source` was a third copy that had drifted: left-aligned under a centred
 * eyebrow, and its CTAs went through a local re-implementation of `Button` that
 * lost the clamp, the focus ring and the press state. Three copies is how a
 * design system dies, so there is one of each here now.
 */

/** One call to action in a hero or closing block. */
export interface PageCtaLink {
	label: string;
	href: string;
	variant?: "default" | "outline" | "secondary";
	/** Lucide key from the shared registry; rendered after the label unless `iconBefore`. */
	icon?: IconKey;
	iconBefore?: boolean;
	external?: boolean;
}

function CtaButton({ cta, size = "default" }: { cta: PageCtaLink; size?: "default" | "lg" }) {
	const glyph = cta.icon ? <Icon k={cta.icon} size={15} /> : null;
	const body = (
		<>
			{cta.iconBefore ? glyph : null}
			{cta.label}
			{cta.iconBefore ? null : glyph}
		</>
	);
	// `render` rather than wrapping the Button in a Link: an <a> around a <button>
	// is invalid, and four call sites across the app were doing exactly that.
	//
	// `mailto:` and `tel:` get a plain anchor with no target — routing them through
	// next/link is pointless, and opening a mail client in a new tab leaves a blank
	// one behind.
	const plainScheme = /^(mailto|tel):/.test(cta.href);
	if (plainScheme) {
		return (
			<Button variant={cta.variant} size={size} nativeButton={false} render={<a href={cta.href} />}>
				{body}
			</Button>
		);
	}
	return cta.external ? (
		<Button variant={cta.variant} size={size} nativeButton={false} render={<a href={cta.href} target="_blank" rel="noreferrer" />}>
			{body}
		</Button>
	) : (
		<Button variant={cta.variant} size={size} nativeButton={false} render={<Link href={cta.href} />}>
			{body}
		</Button>
	);
}

const CTA_ROW: CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 13,
	flexWrap: "wrap",
};

export interface PageHeroProps {
	/** Mono eyebrow inside the rail, e.g. `alethia · pricing`. */
	kicker: string;
	/** The rail's live-dot label, e.g. `open core`. */
	status?: string;
	/** Headline. `muted` becomes a second line in `--text-tertiary`; omit it for one line. */
	headline: { lead: string; muted?: string };
	lede?: ReactNode;
	ctas?: PageCtaLink[];
	/** Mono line under the CTAs — pricing's "free forever" note. */
	footnote?: string;
	/** A product panel rendered under the copy block, full container width. */
	artifact?: ReactNode;
	align?: "center" | "left";
	headlineSize?: number;
	headlineMaxWidth?: number;
	ledeMaxWidth?: number;
	railMaxWidth?: number;
	gridBg?: boolean;
	paddingTop?: number;
	paddingBottom?: number;
}

/** The opening composition of every marketing page. */
export function PageHero({
	kicker,
	status = "operational",
	headline,
	lede,
	ctas = [],
	footnote,
	artifact,
	align = "center",
	headlineSize = 56,
	headlineMaxWidth = 820,
	ledeMaxWidth = 620,
	railMaxWidth = 560,
	gridBg = true,
	paddingTop = 88,
	paddingBottom = 56,
}: PageHeroProps) {
	const centred = align === "center";
	return (
		<section style={{ position: "relative", paddingTop, paddingBottom, overflow: "hidden" }}>
			{gridBg ? <div className="ah-grid-bg" aria-hidden="true" /> : null}
			<Wrap style={{ position: "relative" }}>
				{/* The copy block is its own element so `artifact` can sit beside it at
				    full container width without inheriting the centring. */}
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: centred ? "center" : "flex-start",
						textAlign: centred ? "center" : "left",
						marginBottom: artifact ? 52 : 0,
					}}
				>
					<HeroRail kicker={kicker} status={status} maxWidth={railMaxWidth} />

					<h1
						className="ah-h1"
						style={{
							...disp,
							fontSize: headlineSize,
							fontWeight: 600,
							letterSpacing: "-0.045em",
							lineHeight: 1.04,
							margin: 0,
							maxWidth: headlineMaxWidth,
							color: "var(--text-primary)",
						}}
					>
						{headline.lead}
						{headline.muted ? (
							<>
								<br />
								<span style={{ color: "var(--text-tertiary)" }}>{headline.muted}</span>
							</>
						) : null}
					</h1>

					{lede ? (
						<p
							style={{
								fontSize: 17.5,
								color: "var(--text-secondary)",
								maxWidth: ledeMaxWidth,
								margin: "22px 0 30px",
								lineHeight: 1.55,
							}}
						>
							{lede}
						</p>
					) : null}

					{ctas.length ? (
						<div style={{ ...CTA_ROW, justifyContent: centred ? "center" : "flex-start" }}>
							{ctas.map((cta) => (
								<CtaButton key={cta.label} cta={cta} />
							))}
						</div>
					) : null}

					{footnote ? (
						<p
							style={{
								...mono,
								fontSize: 11,
								color: "var(--text-disabled)",
								letterSpacing: "0.04em",
								margin: "20px 0 0",
							}}
						>
							{footnote}
						</p>
					) : null}
				</div>

				{artifact}
			</Wrap>
		</section>
	);
}

export interface PageCTAProps {
	headline: string;
	lede?: ReactNode;
	ctas: PageCtaLink[];
}

/** The closing block. Same shape as the hero minus the rail, plus the mark. */
export function PageCTA({ headline, lede, ctas }: PageCTAProps) {
	return (
		<section
			style={{
				position: "relative",
				borderTop: "1px solid var(--border)",
				padding: "104px 0 112px",
				overflow: "hidden",
				textAlign: "center",
			}}
		>
			<div className="ah-grid-bg ah-grid-cta" aria-hidden="true" />
			<Wrap style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center" }}>
				<span style={{ color: "var(--text-tertiary)", opacity: 0.55, marginBottom: 22 }}>
					<AlethiaMark size={30} />
				</span>
				<h2
					style={{
						...disp,
						fontSize: 42,
						fontWeight: 600,
						letterSpacing: "-0.04em",
						lineHeight: 1.06,
						margin: 0,
						maxWidth: 640,
						color: "var(--text-primary)",
					}}
				>
					{headline}
				</h2>
				{lede ? (
					<p style={{ fontSize: 16.5, color: "var(--text-secondary)", maxWidth: 560, margin: "20px 0 30px", lineHeight: 1.55 }}>
						{lede}
					</p>
				) : null}
				<div style={{ ...CTA_ROW, justifyContent: "center" }}>
					{ctas.map((cta) => (
						<CtaButton key={cta.label} cta={cta} />
					))}
				</div>
			</Wrap>
		</section>
	);
}

/** Numbered section mark — `01 —— PORTABLE`. */
export function SectionMark({ n, label }: { n: string; label: string }) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
			<span style={{ ...mono, fontSize: 11, color: "var(--text-disabled)", letterSpacing: "0.1em" }}>{n}</span>
			<span style={{ width: 22, height: 1, background: "var(--border-strong)" }} />
			<span style={{ ...eyebrow }}>{label}</span>
		</div>
	);
}

/** Compact star count (2400 → "2.4k"). Was implemented twice, differing only in prefix. */
export function formatStars(n: number | null): string {
	if (n === null) return "";
	if (n < 1000) return String(n);
	const k = n / 1000;
	return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
}

/* ============================================================================
   The minimal compositions.

   `PageHero` / `PageCTA` above are the centred, rail-topped, lede-carrying
   originals; they still serve /open-source and /security. Everything below is
   the quieter shape the home, enterprise and pricing pages moved to: a headline
   hard-left, a short rail on the right, and a lot of air.

   SECTION-LEVEL — each renders `<section>` as its outermost element, so a run of
   them can sit directly under `Reveal`:
       Section · PageOpen · Band · LogoWall · PageClose
   INNER — these render a <p>, a <div> or a row, and must live INSIDE one of the
   above:
       Eyebrow · ActionRow · Rail · Plate · PointGrid

   The split is load bearing, not incidental. `Reveal` selects `:scope > section`
   and `.slice(1)`, so wrapping a run of the section-level ones in a layout <div>
   — or putting an inner one directly under the Reveal root — silently kills
   every scroll animation on the page, with no type error, no lint error and no
   build failure. An earlier version of this comment claimed all of them were
   section-level, which is exactly the mistake it was written to prevent.
   ========================================================================== */

/** One section's vertical rhythm and hairline. Everything below composes it. */
export function Section({
	id,
	bordered = true,
	children,
}: {
	id?: string;
	bordered?: boolean;
	children: ReactNode;
}) {
	return (
		<section
			id={id}
			className="py-[120px] max-[640px]:py-[72px]"
			style={bordered ? { borderTop: "1px solid var(--border)" } : undefined}
		>
			<Wrap>{children}</Wrap>
		</section>
	);
}

/** The only uppercase mono on these pages. */
export function Eyebrow({ children }: { children: string }) {
	return <p className="vx-eyebrow mb-5">{children}</p>;
}

/** A row of CTAs. Square, clamped, from the shared Button — never a pill. */
export function ActionRow({
	ctas,
	size = "default",
	align = "start",
}: {
	ctas: PageCtaLink[];
	size?: "default" | "lg";
	align?: "start" | "center";
}) {
	if (!ctas.length) return null;
	return (
		<div style={{ ...CTA_ROW, justifyContent: align === "center" ? "center" : "flex-start" }}>
			{ctas.map((cta) => (
				<CtaButton key={cta.label} cta={cta} size={size} />
			))}
		</div>
	);
}

/** Headline lines, each its own <span> so the blur-resolve can stagger them. */
function DisplayLines({ lines, className }: { lines: string[]; className: string }) {
	return (
		<span className={`vx-display-in ${className}`}>
			{lines.map((line) => (
				<span key={line}>{line}</span>
			))}
		</span>
	);
}

export interface PageOpenProps {
	/** Hard-broken headline lines — one <span> each, no auto-balancing. */
	lines: string[];
	/**
	 * The right column. `lines` is the home page's three bare statements;
	 * `lede` is a single paragraph, which is what the wider enterprise hero wants.
	 */
	side: { kind: "lines"; items: string[] } | { kind: "lede"; text: string };
	ctas?: PageCtaLink[];
	/** Which column the CTAs sit under. Home: left, under the headline. */
	ctaSide?: "left" | "right";
	gridBg?: boolean;
}

/**
 * The asymmetric opening: a large headline hard-left, a short rail at roughly
 * three-quarters across, and nothing in between. No hero paragraph under the
 * headline, no hero image, no status rail.
 *
 * Server-only by construction — the <h1> is the LCP element and has to be in the
 * initial HTML. Do not reach for state in here.
 */
export function PageOpen({ lines, side, ctas = [], ctaSide = "left", gridBg = true }: PageOpenProps) {
	const actions = ctas.length ? <ActionRow ctas={ctas} /> : null;
	return (
		<section className="relative overflow-hidden pt-[128px] pb-[112px] max-[640px]:pt-[88px] max-[640px]:pb-[72px]">
			{gridBg ? <div className="ah-grid-bg" aria-hidden="true" /> : null}
			<Wrap style={{ position: "relative" }}>
				<div className="grid grid-cols-1 gap-14 lg:grid-cols-[1fr_320px] lg:items-start lg:gap-20">
					<div>
						<h1
							className="font-grotesk text-display-lg font-bold leading-display tracking-display text-text-primary"
							style={{ margin: 0, maxWidth: "13ch" }}
						>
							<DisplayLines lines={lines} className="block" />
						</h1>
						{ctaSide === "left" && actions ? <div className="mt-10">{actions}</div> : null}
					</div>

					<div className="lg:justify-self-end">
						{side.kind === "lines" ? (
							<ul className="m-0 list-none space-y-3.5 p-0">
								{side.items.map((item) => (
									<li key={item} className="text-[13px] leading-[1.6] text-text-secondary">
										{item}
									</li>
								))}
							</ul>
						) : (
							<p className="m-0 text-[13.5px] leading-[1.65] text-text-secondary">{side.text}</p>
						)}
						{ctaSide === "right" && actions ? <div className="mt-9">{actions}</div> : null}
					</div>
				</div>
			</Wrap>
		</section>
	);
}

export interface RailProps {
	/**
	 * One sentence of proof. `lead` takes primary ink and `rest` stays muted, so
	 * the eye lands on the claim and not the sentence.
	 */
	proof: { lead: string; rest: string };
	/** Tiny mono label over the links, e.g. "Console". */
	label: string;
	/** Four. Not three, not six — the count is the discipline. */
	links: { label: string; href: string }[];
}

/** The right-hand rail of a Band: one proof sentence over four plain links. */
export function Rail({ proof, label, links }: RailProps) {
	return (
		<div className="lg:pt-[92px]">
			<p className="m-0 text-[13px] leading-[1.6] text-text-secondary">
				<span className="text-text-primary">{proof.lead}</span>
				{proof.rest}
			</p>
			<p className="vx-eyebrow mt-10 mb-4">{label}</p>
			<ul className="m-0 list-none space-y-2.5 p-0">
				{links.map((link) => (
					<li key={link.href}>
						<Link
							href={link.href}
							className="vx-clamp vx-clamp--tight text-[13px] text-text-secondary no-underline transition-colors hover:text-text-primary"
						>
							{link.label}
						</Link>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * A capability band: two headline lines, one visual, one rail.
 *
 * No icons, no card, no border around the band, no alternating fill. One
 * hairline and 120px of air is the whole separator.
 */
export function Band({
	eyebrow: eyebrowText,
	lines,
	visual,
	rail,
}: {
	eyebrow?: string;
	lines: [string, string];
	/** The band's body — a product panel, a transcript, or a `PointGrid`. */
	visual?: ReactNode;
	rail?: RailProps;
}) {
	return (
		<section
			className="py-[120px] max-[640px]:py-[72px]"
			style={{ borderTop: "1px solid var(--border)" }}
		>
			<Wrap>
				{eyebrowText ? <Eyebrow>{eyebrowText}</Eyebrow> : null}
				{/* Without a rail the body takes the whole width rather than leaving a
				    300px hole where the rail would have been. */}
				<div
					className={
						rail
							? "grid grid-cols-1 gap-y-12 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-x-20"
							: "grid grid-cols-1"
					}
				>
					<div className="min-w-0">
						<h2
							className="mb-12 font-grotesk text-display-sm font-bold tracking-[-0.025em] text-text-primary"
							style={{ margin: "0 0 48px", maxWidth: "16ch", lineHeight: 1.02 }}
						>
							<span className="block">{lines[0]}</span>
							<span className="block">{lines[1]}</span>
						</h2>
						{visual}
					</div>
					{rail ? <Rail {...rail} /> : null}
				</div>
			</Wrap>
		</section>
	);
}

/**
 * A row of provider marks under a mono caption.
 *
 * The caption is the point. Five grayscale logos with no label on a control
 * plane's home page read as "integrations" or, worse, as customers; "Provisions
 * into" makes it a statement about what the product targets. It is not a claim
 * that every cloud is proven end to end — see PROGRAMME.md for what is.
 */
export function LogoWall({ eyebrow: caption, providers }: { eyebrow?: string; providers: Provider[] }) {
	return (
		<section className="py-14" style={{ borderTop: "1px solid var(--border)" }}>
			<Wrap>
				{caption ? <p className="vx-eyebrow mb-7">{caption}</p> : null}
				<div className="flex flex-wrap items-center gap-x-16 gap-y-8">
					{providers.map((provider) => (
						<span key={provider} className="flex items-center gap-2.5">
							<ProviderIcon provider={provider} size={20} className="opacity-55" />
							<span className="text-[12px] text-text-tertiary">
								{PROVIDER_LABELS[provider]}
							</span>
						</span>
					))}
				</div>
			</Wrap>
		</section>
	);
}

/** The closing line and its two actions. One sentence, nothing else. */
export function PageClose({ line, ctas }: { line: string; ctas: PageCtaLink[] }) {
	return (
		<section
			className="relative overflow-hidden py-[128px] text-center max-[640px]:py-[88px]"
			style={{ borderTop: "1px solid var(--border)" }}
		>
			<div className="ah-grid-cta" aria-hidden="true" />
			<Wrap style={{ position: "relative" }}>
				<h2
					className="font-grotesk text-display-sm font-bold tracking-display text-text-primary"
					style={{ margin: "0 auto 36px", maxWidth: "18ch", lineHeight: 1.05 }}
				>
					{line}
				</h2>
				<ActionRow ctas={ctas} align="center" />
			</Wrap>
		</section>
	);
}

/**
 * A hairline plate with a labelled header bar, for product surfaces.
 *
 * Replaces the 126-line `Frame` the enterprise page carried — fake traffic
 * lights, a URL pill with a lock glyph, an `ee` corner tag, and a fake 50px app
 * sidebar rendering six icons. That was a lot of chrome to sell one screenshot.
 * One label bar does the same job.
 */
export function Plate({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div
			style={{
				border: "1px solid var(--border)",
				borderRadius: "var(--radius-md)",
				background: "var(--surface)",
				overflow: "hidden",
				boxShadow: "var(--shadow-md)",
			}}
		>
			<div
				className="flex items-center gap-2.5 px-3.5 py-2.5"
				style={{ borderBottom: "1px solid var(--border-faint)", background: "var(--surface-muted)" }}
			>
				<span className="flex gap-1.5" aria-hidden="true">
					{[0, 1, 2].map((i) => (
						<span
							key={i}
							className="size-[7px] rounded-full"
							style={{ background: "var(--border-strong)" }}
						/>
					))}
				</span>
				<span className="font-mono text-[10.5px] text-text-tertiary">{label}</span>
			</div>
			{children}
		</div>
	);
}

/**
 * A grid of {title, one sentence} points.
 *
 * No icons, deliberately — the same rule the bands follow. The enterprise page
 * previously drew a 38px bordered icon tile beside every one of these, which
 * added a column of decoration to a list whose whole job is to be read.
 */
export function PointGrid({
	points,
	cols = 2,
}: {
	points: { title: string; body: string }[];
	cols?: 2 | 3;
}) {
	return (
		<div
			className={
				cols === 3
					? "grid grid-cols-1 gap-x-14 gap-y-10 sm:grid-cols-2 lg:grid-cols-3"
					: "grid grid-cols-1 gap-x-16 gap-y-10 sm:grid-cols-2"
			}
		>
			{points.map((point) => (
				<div key={point.title}>
					<p
						className="font-grotesk text-[15px] font-semibold text-text-primary"
						style={{ margin: "0 0 8px", letterSpacing: "-0.01em" }}
					>
						{point.title}
					</p>
					<p className="m-0 max-w-[42ch] text-[13px] leading-[1.6] text-text-secondary">
						{point.body}
					</p>
				</div>
			))}
		</div>
	);
}
