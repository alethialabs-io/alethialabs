// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type ReactNode, useRef } from "react";
import Link from "next/link";
import { motion, useInView } from "motion/react";
import { Button } from "@repo/ui/button";
import { STORY } from "../motion/storyboard";
import { SectionShell } from "../motion/section-shell";
import { Reveal, stagger } from "../motion/reveal";
import { Stamp } from "../motion/stamp";
import { Magnetic } from "../motion/magnetic";
import { usePrefersReducedMotion } from "../motion/use-reduced-motion";
import {
	disp,
	eyebrow,
	Icon,
	type IconKey,
	Mark,
	mono,
	Prov,
	type ProviderId,
	Wrap,
} from "../primitives";

/* ============================================================
   (a) Positioning band — "Guardrails that hold zero keys."
   ============================================================ */

/** True when a cloud id has a first-party grayscale provider logo. */
function hasProvLogo(id: string): id is ProviderId {
	return id === "aws" || id === "gcp" || id === "azure";
}

/** Human display names for cloud marks. */
const CLOUD_NAME: Record<string, string> = {
	aws: "AWS",
	gcp: "GCP",
	azure: "Azure",
	hetzner: "Hetzner",
	alibaba: "Alibaba",
};

/**
 * A hairline that draws left→right when its row scrolls in; static full-width
 * under reduced motion so the row still reads as a ruled surface.
 */
function DrawRule({ delay }: { delay: number }) {
	const ref = useRef<HTMLDivElement>(null);
	const inView = useInView(ref, { once: true, amount: 0.6 });
	const reduced = usePrefersReducedMotion();

	if (reduced) {
		return <div ref={ref} style={{ height: 1, background: "var(--border)" }} />;
	}
	return (
		<div ref={ref} style={{ height: 1, overflow: "hidden" }}>
			<motion.div
				style={{ height: 1, background: "var(--border-strong)", transformOrigin: "left center" }}
				initial={{ scaleX: 0 }}
				animate={inView ? { scaleX: 1 } : { scaleX: 0 }}
				transition={{ type: "spring", stiffness: 180, damping: 30, delay }}
			/>
		</div>
	);
}

/** One big typographic differentiator row: a mono index, the claim, a drawn rule. */
function DiffRow({ index, text, i }: { index: string; text: string; i: number }) {
	return (
		<Reveal delay={stagger(i, 0.09)} y={22}>
			<div style={{ padding: "26px 0 0" }}>
				<div style={{ display: "flex", alignItems: "baseline", gap: 20 }}>
					<span
						style={{
							...mono,
							fontSize: 12,
							letterSpacing: "0.14em",
							color: "var(--text-disabled)",
							flexShrink: 0,
							paddingTop: 6,
						}}
					>
						{index}
					</span>
					<h3
						style={{
							...disp,
							fontFamily: "var(--font-grotesk)",
							fontSize: 30,
							lineHeight: 1.12,
							fontWeight: 600,
							letterSpacing: "-0.03em",
							color: "var(--text-primary)",
							margin: 0,
						}}
					>
						{text}
					</h3>
					<span style={{ marginLeft: "auto", color: "var(--text-disabled)", flexShrink: 0, paddingTop: 8 }}>
						<Icon k="arrow" size={16} sw={1.7} />
					</span>
				</div>
				<div style={{ marginTop: 22 }}>
					<DrawRule delay={stagger(i, 0.09) + 0.1} />
				</div>
			</div>
		</Reveal>
	);
}

/** Section 08 — the positioning band: three differentiators as animated rows. */
function PositioningBand() {
	const copy = STORY.positioning;
	return (
		<SectionShell n={copy.n} label={copy.label} title={copy.title}>
			<Reveal>
				<p
					style={{
						fontSize: 16,
						lineHeight: 1.6,
						color: "var(--text-secondary)",
						margin: "0 0 18px",
						maxWidth: 560,
					}}
				>
					{copy.line}
				</p>
			</Reveal>
			<div>
				{copy.diffs.map((diff, i) => (
					<DiffRow key={diff} index={String(i + 1).padStart(2, "0")} text={diff} i={i} />
				))}
			</div>
		</SectionShell>
	);
}

/* ============================================================
   (b) Open source — "Yours to run. We host nothing."
   ============================================================ */

const OS_CLOUDS: readonly string[] = ["aws", "gcp", "azure", "hetzner", "alibaba"];

/** One grayscale cloud chip — logo where first-party, otherwise mono initials. */
function CloudChip({ id }: { id: string }) {
	const name = CLOUD_NAME[id] ?? id;
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 9,
				padding: "9px 13px",
				border: "1px solid var(--border)",
				borderRadius: "var(--radius-sm)",
				background: "var(--surface)",
			}}
		>
			{hasProvLogo(id) ? (
				<Prov id={id} size={16} />
			) : (
				<span
					style={{
						display: "grid",
						placeItems: "center",
						width: 16,
						height: 16,
						...mono,
						fontSize: 9,
						fontWeight: 600,
						color: "var(--text-tertiary)",
						border: "1px solid var(--border-strong)",
						borderRadius: "var(--radius-xs)",
					}}
				>
					{name.slice(0, 2).toUpperCase()}
				</span>
			)}
			<span style={{ ...mono, fontSize: 12, color: "var(--text-secondary)" }}>{name}</span>
		</span>
	);
}

/** Open-source band — self-host on any cloud; the control plane is yours to run. */
function OpenSourceBand() {
	const copy = STORY.openSource;
	return (
		<section style={{ borderTop: "1px solid var(--border)", padding: "96px 0" }}>
			<Wrap>
				<Reveal>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "1.05fr 1fr",
							gap: 48,
							alignItems: "center",
							border: "1px solid var(--border)",
							borderRadius: "var(--radius-lg)",
							background: "var(--surface-sunken)",
							boxShadow: "var(--shadow-md)",
							padding: "44px 44px",
						}}
						className="ah-2col"
					>
						<div>
							<p style={{ ...eyebrow, marginBottom: 18 }}>{copy.label}</p>
							<h2
								style={{
									...disp,
									fontFamily: "var(--font-grotesk)",
									fontSize: 40,
									fontWeight: 600,
									letterSpacing: "-0.04em",
									lineHeight: 1.02,
									margin: "0 0 16px",
									color: "var(--text-primary)",
								}}
							>
								{copy.title}
							</h2>
							<p
								style={{
									fontSize: 16,
									color: "var(--text-secondary)",
									lineHeight: 1.6,
									margin: "0 0 24px",
									maxWidth: 400,
								}}
							>
								{copy.line}
							</p>
							<Link
								href="/open-source"
								style={{
									display: "inline-flex",
									alignItems: "center",
									gap: 8,
									fontSize: 14,
									color: "var(--text-primary)",
									borderBottom: "1px solid var(--border-strong)",
									paddingBottom: 3,
									textDecoration: "none",
								}}
							>
								Explore open source <Icon k="arrow" size={14} />
							</Link>
						</div>
						<div style={{ display: "flex", flexWrap: "wrap", gap: 9, justifyContent: "flex-end" }}>
							{OS_CLOUDS.map((id, i) => (
								<Reveal key={id} delay={stagger(i, 0.06)} y={10}>
									<CloudChip id={id} />
								</Reveal>
							))}
						</div>
					</div>
				</Reveal>
			</Wrap>
		</section>
	);
}

/* ============================================================
   (c) Enterprise — feature grid
   ============================================================ */

const ENTERPRISE_TILES: readonly [IconKey, string, string][] = [
	["building", "Organizations & teams", "Multi-tenant orgs with teams and group-based grants — target a grant at a whole team."],
	["key", "SSO — OIDC & SAML", "Bring your identity provider. New users land least-privileged by default."],
	["shield", "Custom roles & RBAC", "owner · admin · operator · viewer, plus roles you define — OpenFGA over Postgres."],
	["sliders", "Granular IAM", "Allow and deny grants down to a single Project, with a self-serve access portal."],
	["audit", "Audit log", "Every authorization decision recorded — who, what, allowed or denied — and exportable."],
	["layers", "Plans & metering", "community → team → enterprise. Concurrency, runner-minutes, and AI credits scale per plan."],
];

/** Enterprise section — orgs, SSO, RBAC, IAM, audit, and metered plans. */
function EnterpriseGrid() {
	const copy = STORY.enterprise;
	return (
		<SectionShell label="Enterprise" title={copy.title}>
			<Reveal>
				<p style={{ fontSize: 16, lineHeight: 1.6, color: "var(--text-secondary)", margin: "0 0 34px", maxWidth: 620 }}>
					{copy.line}
				</p>
			</Reveal>
			<div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }} className="ah-3col">
				{ENTERPRISE_TILES.map(([ic, title, body], i) => (
					<Reveal key={title} delay={stagger(i, 0.06)} y={18} style={{ height: "100%" }}>
						<div
							style={{
								height: "100%",
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-md)",
								background: "var(--surface)",
								boxShadow: "var(--shadow-md)",
								padding: 22,
							}}
						>
							<span
								style={{
									display: "grid",
									placeItems: "center",
									width: 38,
									height: 38,
									borderRadius: "var(--radius-sm)",
									border: "1px solid var(--border)",
									background: "var(--surface-muted)",
									color: "var(--text-primary)",
									marginBottom: 16,
								}}
							>
								<Icon k={ic} size={18} />
							</span>
							<h3 style={{ ...disp, fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", margin: "0 0 7px", color: "var(--text-primary)" }}>
								{title}
							</h3>
							<p style={{ fontSize: 13, color: "var(--text-tertiary)", margin: 0, lineHeight: 1.55 }}>{body}</p>
						</div>
					</Reveal>
				))}
			</div>
			<Reveal delay={0.1}>
				<div
					style={{
						display: "flex",
						alignItems: "flex-start",
						gap: 9,
						marginTop: 24,
						...mono,
						fontSize: 11,
						color: "var(--text-tertiary)",
						lineHeight: 1.6,
					}}
				>
					<span style={{ flexShrink: 0, paddingTop: 1 }}>
						<Icon k="git" size={13} sw={1.7} />
					</span>
					<span>
						Open core — community RBAC ships free under AGPL-3.0. Organizations, SSO, custom roles,
						OpenFGA, and granular IAM are the commercial{" "}
						<code style={{ color: "var(--text-secondary)" }}>ee/</code> tier.
					</span>
				</div>
			</Reveal>
		</SectionShell>
	);
}

/* ============================================================
   (d) Roadmap band — honest "Coming" items
   ============================================================ */

/** Roadmap section — what is next, each item held to visual honesty with a "Coming" tag. */
function RoadmapBand() {
	const copy = STORY.roadmap;
	return (
		<SectionShell n={copy.n} label={copy.label} title={copy.title} muted>
			<div
				style={{
					border: "1px solid var(--border)",
					borderRadius: "var(--radius-md)",
					background: "var(--surface)",
					overflow: "hidden",
				}}
			>
				{copy.items.map(([label, tag], i) => (
					<Reveal key={label} delay={stagger(i, 0.07)} y={12}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 16,
								padding: "20px 22px",
								borderBottom: i < copy.items.length - 1 ? "1px solid var(--border-faint)" : "none",
							}}
						>
							<span style={{ ...mono, fontSize: 11, letterSpacing: "0.1em", color: "var(--text-disabled)", width: 24, flexShrink: 0 }}>
								{String(i + 1).padStart(2, "0")}
							</span>
							<span
								style={{
									display: "grid",
									placeItems: "center",
									width: 30,
									height: 30,
									flexShrink: 0,
									borderRadius: "var(--radius-xs)",
									border: "1px dashed var(--border-strong)",
									background: "var(--surface-sunken)",
									color: "var(--text-tertiary)",
								}}
							>
								<Icon k="sparkles" size={15} />
							</span>
							<span style={{ ...disp, fontSize: 17, fontWeight: 600, letterSpacing: "-0.01em", color: "var(--text-secondary)" }}>
								{label}
							</span>
							<span
								style={{
									marginLeft: "auto",
									display: "inline-flex",
									alignItems: "center",
									padding: "4px 10px",
									borderRadius: "var(--radius-xs)",
									border: "1px dashed var(--border-strong)",
									...mono,
									fontSize: 9.5,
									letterSpacing: "0.14em",
									textTransform: "uppercase",
									color: "var(--text-tertiary)",
								}}
							>
								{tag}
							</span>
						</div>
					</Reveal>
				))}
			</div>
		</SectionShell>
	);
}

/* ============================================================
   (e) Final CTA — the one sanctioned --cta blue button
   ============================================================ */

/** A tertiary link action rendered as a ghost/outline button in the CTA row. */
function CtaAction({ label, href, variant }: { label: string; href: string; variant: "outline" | "ghost" }) {
	return (
		<Link href={href}>
			<Button size="lg" variant={variant}>
				{variant === "ghost" ? <Icon k="book" size={15} /> : null}
				{label}
			</Button>
		</Link>
	);
}

/** Closing CTA — blueprint grid, the bracketed-point mark, and the one conversion button. */
function FinalCta() {
	const copy = STORY.cta;
	const [primary, demo, docs] = copy.ctas;
	return (
		<section style={{ borderTop: "1px solid var(--border)", padding: "112px 0", position: "relative", overflow: "hidden" }}>
			<div className="ah-grid-bg ah-grid-cta" />
			<Wrap style={{ position: "relative", zIndex: 1, textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
				<Stamp>
					<span style={{ color: "var(--text-primary)", display: "block" }}>
						<Mark size={36} />
					</span>
				</Stamp>
				<Reveal delay={0.05}>
					<h2
						style={{
							...disp,
							fontFamily: "var(--font-grotesk)",
							fontSize: 46,
							fontWeight: 600,
							letterSpacing: "-0.045em",
							lineHeight: 1.03,
							margin: "24px 0 16px",
							maxWidth: 640,
							color: "var(--text-primary)",
						}}
					>
						{copy.title}
					</h2>
				</Reveal>
				<Reveal delay={0.1}>
					<p style={{ fontSize: 17, color: "var(--text-secondary)", maxWidth: 520, margin: "0 0 34px", lineHeight: 1.55 }}>
						{copy.line}
					</p>
				</Reveal>
				<Reveal delay={0.15}>
					<div style={{ display: "flex", gap: 13, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
						<Magnetic strength={0.3}>
							<Link href="/signup">
								<Button size="lg" variant="cta">
									{primary} <Icon k="arrow" size={15} />
								</Button>
							</Link>
						</Magnetic>
						<CtaAction label={demo} href="/contact/enterprise" variant="outline" />
						<CtaAction label={docs} href="/docs" variant="ghost" />
					</div>
				</Reveal>
			</Wrap>
		</section>
	);
}

/* ============================================================
   The closing stack
   ============================================================ */

/**
 * Closing — the homepage's closing stack: the positioning band, the open-source
 * band, the enterprise feature grid, the honest roadmap, and the final CTA that
 * carries the single sanctioned `--cta` conversion button on the whole page.
 */
export function Closing(): ReactNode {
	return (
		<>
			<PositioningBand />
			<OpenSourceBand />
			<EnterpriseGrid />
			<RoadmapBand />
			<FinalCta />
		</>
	);
}
