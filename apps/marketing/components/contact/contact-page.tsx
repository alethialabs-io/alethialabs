// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Metadata } from "next";
import { headers } from "next/headers";
import { LEGAL_ENTITY } from "@repo/legal/entity";
import { SiteShell } from "@repo/brand/site-shell";
import { disp, eyebrow, mono, Wrap } from "@repo/brand/site-primitives";
import { SALES_MAIL, visitorCountry, type ContactTopic } from "@/lib/validations/contact.schema";
import { ContactForm } from "./contact-form";

/**
 * The direct addresses the rail lists, in the order a reader looks for them.
 * Security and privacy have their own inboxes so a vulnerability report or a
 * data request never queues behind a sales thread; the addresses come from the
 * same `LEGAL_ENTITY` record the legal pages read.
 */
const DIRECT_ADDRESSES: { address: string; purpose: string }[] = [
	{ address: SALES_MAIL, purpose: "Demos, trials and services projects" },
	{ address: LEGAL_ENTITY.securityEmail, purpose: "Vulnerability reports" },
	{ address: LEGAL_ENTITY.privacyEmail, purpose: "Data-protection requests" },
];

/** The rail beside the form: eyebrow, headline, one sentence, and the direct addresses. */
function LeftRail() {
	return (
		<div>
			<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
				<span style={{ ...mono, fontSize: 11, color: "var(--text-disabled)", letterSpacing: "0.1em" }}>
					—
				</span>
				<span style={eyebrow}>Contact</span>
			</div>
			<h1
				style={{
					...disp,
					fontSize: "clamp(32px, 5vw, 44px)",
					fontWeight: 600,
					letterSpacing: "-0.04em",
					lineHeight: 1.05,
					margin: "0 0 18px",
					color: "var(--text-primary)",
				}}
			>
				Tell us what you need.
			</h1>
			<p
				style={{
					fontSize: 16.5,
					color: "var(--text-secondary)",
					lineHeight: 1.55,
					margin: "0 0 36px",
					maxWidth: 440,
				}}
			>
				One form for demos, trials and projects. We reply by email.
			</p>
			<p className="vx-eyebrow" style={{ margin: "0 0 4px" }}>
				Or write directly
			</p>
			<ul style={{ listStyle: "none", margin: 0, padding: 0, borderTop: "1px solid var(--border)" }}>
				{DIRECT_ADDRESSES.map(({ address, purpose }) => (
					<li
						key={address}
						style={{
							display: "flex",
							flexDirection: "column",
							gap: 4,
							padding: "14px 0",
							borderBottom: "1px solid var(--border)",
						}}
					>
						<a
							href={`mailto:${address}`}
							style={{ ...mono, fontSize: 13, color: "var(--text-primary)", overflowWrap: "anywhere" }}
						>
							{address}
						</a>
						<span style={{ fontSize: 12.5, color: "var(--text-tertiary)" }}>{purpose}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The contact page body: the rail on the left and the sticky form on the right.
 * `topic` is the form's preset — from `?topic=`, or from the `/contact/sales`
 * and `/contact/enterprise` deep links. The form is keyed on it so a client-side
 * navigation between two presets re-seeds the form instead of keeping the old one.
 */
export function ContactSection({ topic, country }: { topic: ContactTopic; country?: string }) {
	return (
		<section style={{ position: "relative", overflow: "hidden", borderBottom: "1px solid var(--border)" }}>
			<div className="ah-grid-bg" />
			<Wrap style={{ position: "relative", paddingBlock: "64px 80px" }}>
				<div className="grid grid-cols-1 gap-10 lg:grid-cols-[0.92fr_1fr] lg:gap-16 lg:items-start">
					<LeftRail />
					<div className="min-w-0 lg:sticky lg:top-[86px]">
						<ContactForm key={topic} topic={topic} defaultCountry={country} showTopic />
					</div>
				</div>
			</Wrap>
		</section>
	);
}

/** The metadata every contact route shares. The two deep links canonicalise to `/contact`. */
export const CONTACT_METADATA: Metadata = {
	title: "Contact",
	description:
		"Ask for a product demo, start an Enterprise trial, or tell us about a platform, cloud or AI project. One form; we reply by email.",
	alternates: { canonical: "/contact" },
};

/**
 * A whole contact route — the shared site chrome around {@link ContactSection}.
 * `/contact`, `/contact/sales` and `/contact/enterprise` all render this and
 * differ only in the topic they preset.
 */
export async function ContactPage({ topic }: { topic: ContactTopic }) {
	// Open the country field on the visitor's own country rather than on Bulgaria for everyone.
	const country = visitorCountry((await headers()).get("cf-ipcountry"));
	return (
		<SiteShell>
			<ContactSection topic={topic} country={country} />
		</SiteShell>
	);
}
