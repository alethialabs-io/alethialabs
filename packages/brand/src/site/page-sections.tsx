// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Button } from "@repo/ui/button";

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
