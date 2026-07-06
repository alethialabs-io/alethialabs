// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { disp, eyebrow, Icon, type IconKey, mono, Wrap } from "@/components/landing/home/primitives";
import type { ContactLeadType } from "@/lib/validations/contact.schema";
import { ContactForm } from "./contact-form";

/** A single value-prop in the left rail: icon, title, description. */
export type RailPoint = [icon: IconKey, title: string, description: string];

export interface ContactRail {
	tag: string;
	title: string;
	sub: string;
	points: RailPoint[];
	/** Optional footer note under the value props. */
	foot?: string;
}

/** The pitch rail beside the form — eyebrow, headline, sub, and value props. */
function LeftRail({ tag, title, sub, points, foot }: ContactRail) {
	return (
		<div>
			<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
				<span style={{ ...mono, fontSize: 11, color: "var(--text-disabled)", letterSpacing: "0.1em" }}>
					—
				</span>
				<span style={eyebrow}>{tag}</span>
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
				{title}
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
				{sub}
			</p>
			<div style={{ display: "flex", flexDirection: "column", gap: 2, borderTop: "1px solid var(--border)" }}>
				{points.map(([ic, t, d]) => (
					<div key={t} style={{ display: "flex", gap: 14, padding: "18px 0", borderBottom: "1px solid var(--border)" }}>
						<span
							style={{
								display: "grid",
								placeItems: "center",
								width: 38,
								height: 38,
								flexShrink: 0,
								borderRadius: "var(--radius-md)",
								border: "1px solid var(--border)",
								background: "var(--surface-muted)",
								color: "var(--text-primary)",
							}}
						>
							<Icon k={ic} size={18} />
						</span>
						<div>
							<div style={{ ...disp, fontSize: 14.5, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
								{t}
							</div>
							<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", lineHeight: 1.5, margin: 0, maxWidth: 380 }}>
								{d}
							</p>
						</div>
					</div>
				))}
			</div>
			{foot && (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 9,
						marginTop: 22,
						...mono,
						fontSize: 11.5,
						color: "var(--text-tertiary)",
					}}
				>
					<Icon k="route" size={13} sw={1.7} />
					{foot}
				</div>
			)}
		</div>
	);
}

export interface ContactSectionProps {
	type: ContactLeadType;
	submitLabel: string;
	rail: ContactRail;
	/** Cross-link card to the sibling contact page. */
	crossLabel: string;
	crossHref: string;
	crossSub: string;
}

/**
 * The contact hero: a split layout with the pitch rail on the left and the
 * sticky form (plus a cross-link card to the sibling page) on the right. Page
 * routes wrap this with the shared landing Header/Footer.
 */
export function ContactSection({
	type,
	submitLabel,
	rail,
	crossLabel,
	crossHref,
	crossSub,
}: ContactSectionProps) {
	return (
		<section style={{ position: "relative", overflow: "hidden", borderBottom: "1px solid var(--border)" }}>
			<div className="ah-grid-bg" />
			<Wrap style={{ position: "relative", padding: "64px 32px 80px" }}>
				<div className="grid grid-cols-1 gap-10 lg:grid-cols-[0.92fr_1fr] lg:gap-16 lg:items-start">
					<LeftRail {...rail} />
					<div className="lg:sticky lg:top-[86px]">
						<ContactForm type={type} submitLabel={submitLabel} />
						<Link
							href={crossHref}
							className="mt-3.5 flex items-center gap-3.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-sunken)] px-[18px] py-[15px] no-underline transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--surface-muted)]"
						>
							<div style={{ minWidth: 0 }}>
								<div style={{ ...disp, fontSize: 13.5, fontWeight: 600, color: "var(--text-primary)" }}>
									{crossLabel}
								</div>
								<div style={{ fontSize: 11.5, color: "var(--text-tertiary)", marginTop: 2 }}>
									{crossSub}
								</div>
							</div>
							<span style={{ marginLeft: "auto", color: "var(--text-tertiary)", flexShrink: 0 }}>
								<Icon k="arrow" size={15} />
							</span>
						</Link>
					</div>
				</div>
			</Wrap>
		</section>
	);
}
