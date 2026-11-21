// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { SiteShell } from "@repo/brand/site-shell";
import { Band, Eyebrow, PageClose, PageOpen, Section } from "@repo/brand/site-sections";
import { Reveal } from "@/components/landing/reveal";

export const metadata: Metadata = {
	title: "About",
	description:
		"Alethia Labs builds Alethia, the multi-cloud Kubernetes control plane, and takes on platform, cloud and AI engineering for other teams.",
};

/**
 * The founder photo, as the browser requests it and as it sits on disk.
 *
 * It lives under `mkt-assets/` because that prefix is the only static path the
 * edge routes to this app: Caddy and `marketing-zones.json` send `/about` (exact)
 * here and everything below `/about/` to the console, so a file served at
 * `/about/<name>.jpg` would never reach us. The source belongs in
 * `packages/assets/static/mkt-assets/about/`, which `sync-public-assets.mjs`
 * copies into `public/` before every dev run and build.
 */
const FOUNDER_PHOTO_URL = "/mkt-assets/about/borislav-borisov.jpg";
const FOUNDER_PHOTO_FILE = join(process.cwd(), "public", "mkt-assets", "about", "borislav-borisov.jpg");

/** Links under the founder's name. Both leave the site. */
const FOUNDER_LINKS: { label: string; href: string }[] = [
	{ label: "LinkedIn", href: "https://www.linkedin.com/in/bborisov1/" },
	{ label: "tovr.eu", href: "https://tovr.eu" },
];

/** The two halves of the company, as tiles. */
const WHAT_WE_DO: { name: string; body: string; href: string; cta: string }[] = [
	{
		name: "Alethia",
		body: "The control plane: provision and govern Kubernetes on the clouds you already run, from a console or the CLI.",
		href: "/",
		cta: "The product",
	},
	{
		name: "Labs",
		body: "Senior platform, cloud and AI engineering for teams that need it built properly the first time.",
		href: "/services",
		cta: "Services",
	},
];

/** Company facts, read from the same record the imprint publishes. */
const COMPANY_FACTS: { label: string; value: string }[] = [
	{ label: "Legal name", value: `${LEGAL_ENTITY.legalName} (${LEGAL_ENTITY.legalNameBulgarian})` },
	{ label: "Legal form", value: LEGAL_ENTITY.legalForm },
	{ label: "Registration (EIK)", value: LEGAL_ENTITY.registrationNumber },
	{ label: "Registered office", value: LEGAL_ENTITY.registeredAddress },
];

/** Opening: the headline and one sentence on what the company is. */
function Hero() {
	return (
		<PageOpen
			lines={["Built by engineers", "who run what they ship."]}
			side={{
				kind: "lede",
				text: "Alethia Labs builds Alethia, the multi-cloud Kubernetes control plane, and helps other teams run platforms of their own.",
			}}
		/>
	);
}

/**
 * The founder block. The photo is rendered only once the file exists — until
 * the maintainer supplies it there is no placeholder, no initials and no stock
 * or generated image in its place (packages/brand/README.md: no stock or
 * AI-generated assets). The check runs on the server, at build or request time;
 * the standalone server chdirs into this app, so `public/` resolves either way.
 */
function Founder() {
	const hasPhoto = existsSync(FOUNDER_PHOTO_FILE);
	return (
		<Section>
			<Eyebrow>Founder</Eyebrow>
			<div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:gap-12">
				{hasPhoto ? (
					// A plain <img>, not next/image: the optimiser's endpoint is not one of the
					// paths the edge routes to this app, and one fixed-size portrait does not
					// need it.
					// eslint-disable-next-line @next/next/no-img-element
					<img
						src={FOUNDER_PHOTO_URL}
						alt="Borislav Borisov"
						width={160}
						height={160}
						className="shrink-0 rounded-[var(--radius-lg)] border border-[var(--border)] object-cover grayscale"
						style={{ width: 160, height: 160 }}
					/>
				) : null}
				<div className="min-w-0">
					<h2
						className="font-grotesk text-display-sm font-bold tracking-[-0.025em] text-text-primary"
						style={{ margin: "0 0 10px", lineHeight: 1.02 }}
					>
						Borislav Borisov
					</h2>
					<p className="m-0 mb-5 text-[13px] text-text-tertiary">
						Founder &amp; CEO, Alethia Labs · Co-founder, TOVR
					</p>
					<p className="m-0 max-w-[52ch] text-[13.5px] leading-[1.65] text-text-secondary">
						Studied at Politecnico di Torino.
						<br />
						Based between Sofia and Turin.
					</p>
					<ul className="mt-6 flex list-none flex-wrap gap-x-6 gap-y-2 p-0">
						{FOUNDER_LINKS.map((link) => (
							<li key={link.href}>
								<a
									href={link.href}
									target="_blank"
									rel="noreferrer"
									className="vx-clamp vx-clamp--tight text-[13px] text-text-secondary no-underline transition-colors hover:text-text-primary"
								>
									{link.label} ↗
								</a>
							</li>
						))}
					</ul>
				</div>
			</div>
		</Section>
	);
}

/** Product and services, side by side. */
function WhatWeDo() {
	return (
		<Band
			eyebrow="What we do"
			lines={["One product.", "One engineering practice."]}
			visual={
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					{WHAT_WE_DO.map((tile) => (
						<Link
							key={tile.name}
							href={tile.href}
							className="group flex flex-col rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-6 no-underline transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]"
						>
							<span className="font-grotesk text-[18px] font-semibold tracking-[-0.01em] text-text-primary">
								{tile.name}
							</span>
							<span className="mt-2 text-[13px] leading-[1.6] text-text-secondary">{tile.body}</span>
							<span className="mt-6 text-[12.5px] text-text-tertiary transition-colors group-hover:text-text-primary">
								{tile.cta} →
							</span>
						</Link>
					))}
				</div>
			}
		/>
	);
}

/** The registered company, as the imprint states it, with a link to the imprint. */
function Company() {
	return (
		<Band
			eyebrow="Company"
			lines={["A Bulgarian company,", "on the public register."]}
			visual={
				<div>
					<dl className="m-0" style={{ borderTop: "1px solid var(--border)" }}>
						{COMPANY_FACTS.map((fact) => (
							<div
								key={fact.label}
								className="grid grid-cols-1 gap-1 py-3.5 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-6"
								style={{ borderBottom: "1px solid var(--border)" }}
							>
								<dt className="vx-eyebrow" style={{ margin: 0 }}>
									{fact.label}
								</dt>
								<dd className="m-0 text-[13.5px] leading-[1.6] text-text-primary">{fact.value}</dd>
							</div>
						))}
					</dl>
					<Link
						href="/imprint"
						className="vx-clamp vx-clamp--tight mt-6 inline-block text-[13px] text-text-secondary no-underline transition-colors hover:text-text-primary"
					>
						Full company information →
					</Link>
				</div>
			}
		/>
	);
}

/**
 * Public company page: who builds Alethia, what the company does, and the
 * registered facts.
 *
 * `Reveal` selects `:scope > section` and skips the first, so every child below
 * renders `<section>` as its outermost element — a wrapper div here would
 * silently kill every scroll animation on the page.
 */
export default function AboutPage() {
	return (
		<SiteShell>
			<Reveal>
				<Hero />
				<Founder />
				<WhatWeDo />
				<Company />
				<PageClose line="Questions, or a project in mind?" ctas={[{ label: "Contact", href: "/contact" }]} />
			</Reveal>
		</SiteShell>
	);
}
