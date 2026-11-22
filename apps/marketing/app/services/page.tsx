// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { cloudListLabel, PROVISIONABLE_CLOUDS } from "@repo/cloud-catalog";
import { SiteShell } from "@repo/brand/site-shell";
import { ActionRow, Band, PageOpen, Section } from "@repo/brand/site-sections";
import { Reveal } from "@/components/landing/reveal";

export const metadata: Metadata = {
	title: "Services",
	description:
		"Senior platform, cloud and AI engineering for EU startups, from the team behind Alethia — Kubernetes platforms, cost and security audits, product builds, and AI agents.",
};

/** Where every call to action on this page goes: the contact form, preset to a services project. */
const CONTACT_SERVICES = "/contact?topic=services";

/**
 * The four services. Each `proof` names something we built and run ourselves,
 * not a client claim. There are no prices and no durations anywhere on this
 * page by decision — scope is agreed per project, by email.
 */
const SERVICES: { title: string; body: string; proof: string }[] = [
	{
		title: "Platform & Kubernetes",
		body: "Production clusters, GitOps and CI/CD on your cloud, documented and handed over.",
		// Derived, not typed: the count of clouds is what drifts first.
		proof: `Alethia provisions policy-verified clusters on ${cloudListLabel(PROVISIONABLE_CLOUDS)}.`,
	},
	{
		title: "Cloud cost & security audits",
		body: "A fixed-scope written report, findings ranked by money and risk, with the fixes.",
		proof: "Alethia's keyless runner: no stored access keys on AWS, GCP or Azure.",
	},
	{
		title: "Product builds",
		body: "MVPs and internal tools in Next.js and Go, shipped to production.",
		proof: "The Alethia console, CLI and runner.",
	},
	{
		title: "AI agents & LLM integration",
		body: "Agents wired into your workflows, with guardrails and evals.",
		proof: "Alethia's agent harness, and TOVR's freight AI.",
	},
];

/** The engagement shape, in order. */
const STEPS: { n: string; title: string; body: string }[] = [
	{ n: "01", title: "Audit", body: "Read-only access to one repository. Never your cloud credentials." },
	{ n: "02", title: "Build", body: "A scoped sprint against what the audit found." },
	{ n: "03", title: "Run", body: "Ongoing ownership of the platform, if you want it." },
];

/** Opening: the headline, one sentence, one action. */
function Hero() {
	return (
		<PageOpen
			lines={["We build platforms", "the way we build ours."]}
			ctaSide="right"
			side={{
				kind: "lede",
				text: "Senior platform, cloud and AI engineering for EU startups, from the team behind Alethia.",
			}}
			ctas={[{ label: "Contact", href: CONTACT_SERVICES }]}
		/>
	);
}

/** The four services as tiles: title, one sentence, one proof line. */
function Services() {
	return (
		<Band
			eyebrow="Services"
			lines={["Four kinds of work.", "Each one proven on our own."]}
			visual={
				<ul className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2">
					{SERVICES.map((service) => (
						<li
							key={service.title}
							className="flex flex-col rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-6"
						>
							<p
								className="font-grotesk text-[15px] font-semibold text-text-primary"
								style={{ margin: "0 0 8px", letterSpacing: "-0.01em" }}
							>
								{service.title}
							</p>
							<p className="m-0 text-[13px] leading-[1.6] text-text-secondary">{service.body}</p>
							<p
								className="m-0 mt-5 pt-4 text-[12px] leading-[1.55] text-text-tertiary"
								style={{ borderTop: "1px solid var(--border-faint)" }}
							>
								<span className="font-mono text-[10.5px] uppercase tracking-[0.08em]">Proof · </span>
								{service.proof}
							</p>
						</li>
					))}
				</ul>
			}
		/>
	);
}

/** Audit → Build → Run, as an ordered strip. */
function HowWeWork() {
	return (
		<Band
			eyebrow="How we work"
			lines={["Audit, build, run.", "In that order."]}
			visual={
				<ol className="m-0 grid list-none grid-cols-1 gap-x-14 gap-y-10 p-0 sm:grid-cols-3">
					{STEPS.map((step) => (
						<li key={step.n} style={{ borderTop: "1px solid var(--border-strong)", paddingTop: 18 }}>
							<span className="font-mono text-[11px] tracking-[0.1em] text-text-disabled">{step.n}</span>
							<p
								className="font-grotesk text-[15px] font-semibold text-text-primary"
								style={{ margin: "10px 0 8px", letterSpacing: "-0.01em" }}
							>
								{step.title}
							</p>
							<p className="m-0 max-w-[32ch] text-[13px] leading-[1.6] text-text-secondary">{step.body}</p>
						</li>
					))}
				</ol>
			}
		/>
	);
}

/**
 * The close. `PageClose` has no slot for a note, and this one needs "We reply
 * by email." under the button — the page promises no call and no calendar — so
 * it is composed from `Section` and `ActionRow` with `PageClose`'s heading type.
 */
function Close() {
	return (
		<Section>
			<div className="text-center">
				<h2
					className="font-grotesk text-display-sm font-bold tracking-display text-text-primary"
					style={{ margin: "0 auto 36px", maxWidth: "18ch", lineHeight: 1.05 }}
				>
					Tell us what you&apos;re running.
				</h2>
				<ActionRow ctas={[{ label: "Contact", href: CONTACT_SERVICES }]} align="center" />
				<p className="m-0 mt-5 text-[12.5px] text-text-tertiary">We reply by email.</p>
			</div>
		</Section>
	);
}

/**
 * Public services page: what Alethia Labs takes on for other teams, and how an
 * engagement runs. No prices, no durations, no booking tool — every path ends
 * at the contact form.
 *
 * `Reveal` selects `:scope > section` and skips the first, so every child below
 * renders `<section>` as its outermost element — a wrapper div here would
 * silently kill every scroll animation on the page.
 */
export default function ServicesPage() {
	return (
		<SiteShell>
			<Reveal>
				<Hero />
				<Services />
				<HowWeWork />
				<Close />
			</Reveal>
		</SiteShell>
	);
}
