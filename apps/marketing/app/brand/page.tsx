// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AlethiaLogo } from "@repo/brand/alethia-logo";
import { BRAND_STATUS } from "@repo/brand/status";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
	title: "Brand · Alethia Labs",
	description:
		"The Alethia Labs identity, mark construction, typography, color, spacing, and interface principles.",
};

const GRAYS = [
	["Paper", "#FAFAFA"],
	["Mist", "#EDEDED"],
	["Graphite", "#737373"],
	["Carbon", "#2A2A2A"],
	["Ink", "#0A0A0A"],
] as const;

const TYPE_SAMPLES = [
	{
		name: "Space Grotesk",
		role: "Display · product and company voice",
		className: "font-[family-name:var(--font-space-grotesk)]",
		sample: "Truth, brought into focus.",
	},
	{
		name: "Geist",
		role: "Interface · prose and controls",
		className: "font-sans",
		sample: "Configure infrastructure visually. Deploy from the terminal.",
	},
	{
		name: "Geist Mono",
		role: "Data · code and eyebrow labels",
		className: "font-mono",
		sample: "EKS · eu-west-1 · v1.31",
	},
] as const;

/** Public, review-safe presentation of Alethia's interim identity system. */
export default function BrandPage() {
	return (
		<div className="min-h-screen bg-background text-foreground">
			<BrandNav />
			<main>
				<section className="relative overflow-hidden border-b border-border">
					<div className="ah-grid-bg" aria-hidden="true" />
					<div className="relative mx-auto max-w-6xl px-6 py-28 sm:py-36">
						<p className="vx-eyebrow">Alethia Labs · Brand system</p>
						<h1 className="mt-7 max-w-4xl font-[family-name:var(--font-space-grotesk)] text-5xl font-semibold tracking-[-0.055em] sm:text-7xl">
							Truth, brought
							<br />
							into focus.
						</h1>
						<p className="mt-8 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
							A technical identity built from restraint: a point, a frame, and a
							neutral field. This page is the reference for Alethia-owned product
							and company surfaces.
						</p>
						<div className="mt-10 inline-flex items-center gap-3 border border-border-strong bg-surface px-4 py-3">
							<span className="size-2 rounded-full border border-foreground bg-transparent" />
							<span className="font-mono text-[11px] uppercase tracking-[0.14em]">
								{BRAND_STATUS.label}
							</span>
						</div>
					</div>
				</section>

				<BrandSection eyebrow="01 · Identity" title="One point. Held in focus.">
					<div className="grid overflow-hidden border border-border lg:grid-cols-2">
						<div className="relative grid min-h-96 place-items-center border-b border-border bg-surface-sunken p-12 lg:border-r lg:border-b-0">
							<div
								className="absolute inset-0 opacity-60"
								style={{
									backgroundImage:
										"linear-gradient(var(--border-faint) 1px, transparent 1px), linear-gradient(90deg, var(--border-faint) 1px, transparent 1px)",
									backgroundSize: "32px 32px",
								}}
							/>
							<AlethiaLogo
								className="relative size-48 text-foreground"
								aria-label="Alethia bracketed point mark"
							/>
							<span className="absolute top-4 left-4 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
								32 × 32 construction grid
							</span>
						</div>
						<div className="flex flex-col justify-between p-8 sm:p-12">
							<div>
								<p className="vx-eyebrow">The bracketed point</p>
								<p className="mt-5 text-lg leading-8 text-muted-foreground">
									The point is a claim made precise. The brackets hold context
									without closing it. Together they represent aletheia:
									unconcealment, evidence, and systems made legible.
								</p>
							</div>
							<dl className="mt-12 grid grid-cols-2 gap-px border border-border bg-border">
								<Metric term="Clear space" value="1 dot diameter" />
								<Metric term="Minimum mark" value="16 px" />
								<Metric term="Stroke" value="2.4 / 32" />
								<Metric term="Ink" value="currentColor" />
							</dl>
						</div>
					</div>
				</BrandSection>

				<BrandSection eyebrow="02 · Lockups" title="Company, product, and app.">
					<div className="grid gap-4 md:grid-cols-2">
						<LogoField label="Company lockup · dark field" dark>
							<AlethiaLogo withText className="h-12 w-auto text-white" />
						</LogoField>
						<LogoField label="Company lockup · light field">
							<AlethiaLogo withText className="h-12 w-auto text-black" />
						</LogoField>
						<LogoField label="Product mark · clear space" dark>
							<div className="border border-dashed border-white/25 p-8">
								<AlethiaLogo className="size-20 text-white" />
							</div>
						</LogoField>
						<LogoField label="App icon · dark-only tile">
							<div className="grid size-32 place-items-center rounded-[28px] bg-[#1A1A1A]">
								<AlethiaLogo className="size-20 text-[#FAFAFA]" />
							</div>
						</LogoField>
					</div>
					<div className="mt-5 border border-border bg-surface p-5">
						<p className="text-sm leading-6 text-muted-foreground">
							<strong className="font-medium text-foreground">Interim use only.</strong>{" "}
							{BRAND_STATUS.note} Downloadable asset links stay disabled until the
							clearance review is closed.
						</p>
					</div>
				</BrandSection>

				<BrandSection eyebrow="03 · Typography" title="Three voices. One hierarchy.">
					<div className="divide-y divide-border border-y border-border">
						{TYPE_SAMPLES.map((font) => (
							<div
								key={font.name}
								className="grid gap-5 py-8 md:grid-cols-[220px_1fr] md:items-baseline"
							>
								<div>
									<p className="text-sm font-medium">{font.name}</p>
									<p className="mt-1 text-xs text-muted-foreground">{font.role}</p>
								</div>
								<p
									className={`${font.className} text-2xl tracking-tight sm:text-4xl`}
								>
									{font.sample}
								</p>
							</div>
						))}
					</div>
				</BrandSection>

				<BrandSection eyebrow="04 · Color" title="Neutral by default. Blue once.">
					<div className="grid grid-cols-2 border-t border-l border-border sm:grid-cols-5">
						{GRAYS.map(([name, color]) => (
							<div key={name} className="border-r border-b border-border">
								<div className="aspect-square" style={{ background: color }} />
								<div className="bg-surface p-4">
									<p className="text-sm font-medium">{name}</p>
									<p className="mt-1 font-mono text-[10px] text-muted-foreground">
										{color}
									</p>
								</div>
							</div>
						))}
					</div>
					<div className="mt-6 grid border border-border md:grid-cols-[180px_1fr]">
						<div className="min-h-36 bg-[#2563EB]" />
						<div className="p-6 sm:p-8">
							<p className="vx-eyebrow">Conversion blue · #2563EB</p>
							<p className="mt-4 max-w-2xl text-sm leading-6 text-muted-foreground">
								Reserved for one primary conversion action per view. It is not a
								brand-mark color, status color, chart palette, or decorative accent.
								Third-party provider marks may retain their own colors.
							</p>
						</div>
					</div>
				</BrandSection>

				<BrandSection eyebrow="05 · Interface" title="Structure carries the system.">
					<div className="grid gap-px border border-border bg-border md:grid-cols-3">
						<SystemCard number="4 px" title="Spacing grid">
							Dense interface rhythm. Generous space is reserved for narrative
							and first-run moments.
						</SystemCard>
						<SystemCard number="1 px" title="Hairline borders">
							Borders define surfaces and hierarchy. Shadows stay quiet and
							secondary.
						</SystemCard>
						<SystemCard number="80–480 ms" title="Mechanical motion">
							State changes are restrained, interruptible, and disabled when
							reduced motion is preferred.
						</SystemCard>
						<SystemCard number="2–6 px" title="Surface radii">
							Controls remain precise. Larger radii belong only to app tiles and
							high-level containers.
						</SystemCard>
						<SystemCard number="3 px" title="Focus ring">
							Every interactive element exposes a visible keyboard focus state
							with sufficient contrast.
						</SystemCard>
						<SystemCard number="0 hue" title="Status language">
							Shape, fill, and a mono label communicate state. Never color alone.
						</SystemCard>
					</div>
				</BrandSection>

				<BrandSection eyebrow="06 · Voice" title="Quiet. Exact. Verifiable.">
					<div className="grid gap-4 md:grid-cols-2">
						<VoiceCard title="Write this">
							“Deploy from the terminal. Zero credentials stored.”
						</VoiceCard>
						<VoiceCard title="Avoid this" muted>
							“Supercharge your cloud journey with magical automation!”
						</VoiceCard>
						<VoiceCard title="Sentence case">
							Use direct verbs, concrete nouns, and the figure before the
							explanation.
						</VoiceCard>
						<VoiceCard title="Technical values">
							<span className="font-mono">EKS · eu-west-1 · v1.31</span>
						</VoiceCard>
					</div>
				</BrandSection>
			</main>
			<footer className="border-t border-border">
				<div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-10 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
					<p>© 2026 Alethia Labs · Interim brand reference</p>
					<div className="flex gap-5">
						<Link href="/privacy" className="hover:text-foreground">
							Privacy
						</Link>
						<Link href="/cookies" className="hover:text-foreground">
							Cookies
						</Link>
						<Link href="/contact/sales" className="hover:text-foreground">
							Contact
						</Link>
					</div>
				</div>
			</footer>
		</div>
	);
}

/** Minimal page navigation that keeps the brand specimen self-contained. */
function BrandNav() {
	return (
		<header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur-md">
			<div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
				<Link href="/" aria-label="Alethia Labs home">
					<AlethiaLogo withText className="h-7 w-auto" />
				</Link>
				<nav className="flex items-center gap-6 text-xs text-muted-foreground">
					<span className="hidden font-mono uppercase tracking-[0.14em] sm:inline">
						Brand reference
					</span>
					<Link href="/contact/sales" className="text-foreground hover:opacity-70">
						Contact
					</Link>
				</nav>
			</div>
		</header>
	);
}

/** Section frame shared across the public brand reference. */
function BrandSection({
	eyebrow,
	title,
	children,
}: {
	eyebrow: string;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="border-b border-border">
			<div className="mx-auto max-w-6xl px-6 py-20 sm:py-28">
				<p className="vx-eyebrow">{eyebrow}</p>
				<h2 className="mt-5 font-[family-name:var(--font-space-grotesk)] text-3xl font-semibold tracking-[-0.045em] sm:text-5xl">
					{title}
				</h2>
				<div className="mt-12">{children}</div>
			</div>
		</section>
	);
}

/** One construction metric. */
function Metric({ term, value }: { term: string; value: string }) {
	return (
		<div className="bg-background p-4">
			<dt className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
				{term}
			</dt>
			<dd className="mt-2 text-sm">{value}</dd>
		</div>
	);
}

/** Light or dark specimen field for a logo treatment. */
function LogoField({
	label,
	dark = false,
	children,
}: {
	label: string;
	dark?: boolean;
	children: React.ReactNode;
}) {
	return (
		<div
			className={`relative grid min-h-72 place-items-center border border-border p-10 ${
				dark ? "bg-[#0A0A0A]" : "bg-[#FAFAFA]"
			}`}
		>
			<p
				className={`absolute top-4 left-4 font-mono text-[9px] uppercase tracking-[0.14em] ${
					dark ? "text-white/45" : "text-black/45"
				}`}
			>
				{label}
			</p>
			{children}
		</div>
	);
}

/** Compact design-system principle card. */
function SystemCard({
	number,
	title,
	children,
}: {
	number: string;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<article className="min-h-64 bg-background p-7">
			<p className="font-mono text-2xl">{number}</p>
			<h3 className="mt-10 text-base font-semibold">{title}</h3>
			<p className="mt-3 text-sm leading-6 text-muted-foreground">{children}</p>
		</article>
	);
}

/** Brand voice example card. */
function VoiceCard({
	title,
	children,
	muted = false,
}: {
	title: string;
	children: React.ReactNode;
	muted?: boolean;
}) {
	return (
		<article
			className={`border p-7 ${muted ? "border-dashed border-border" : "border-border bg-surface"}`}
		>
			<p className="vx-eyebrow">{title}</p>
			<p
				className={`mt-7 text-xl leading-8 ${muted ? "text-muted-foreground line-through decoration-1" : "text-foreground"}`}
			>
				{children}
			</p>
		</article>
	);
}
