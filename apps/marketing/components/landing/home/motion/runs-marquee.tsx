// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { type CSSProperties, type ReactNode } from "react";
import {
	disp,
	IntegrationLogo,
	type IntegrationId,
	mono,
	Prov,
	type ProviderId,
} from "../primitives";
import { usePrefersReducedMotion } from "./use-reduced-motion";

const PROVS: [ProviderId, string][] = [
	["aws", "AWS"],
	["gcp", "GCP"],
	["azure", "Azure"],
];

const INTEGRATIONS: IntegrationId[] = [
	"github",
	"gitlab",
	"bitbucket",
	"cloudflare",
	"datadog",
	"grafana",
	"prometheus",
	"dockerhub",
];

/** One provider chip: grayscale logo + display label. */
function ProvChip({ id, label }: { id: ProviderId; label: string }) {
	return (
		<span style={{ display: "inline-flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" }}>
			<Prov id={id} size={20} />
			<span style={{ ...disp, fontSize: 14, fontWeight: 500, color: "var(--text-secondary)" }}>
				{label}
			</span>
		</span>
	);
}

/** Thin vertical hairline separating marquee items. */
function Sep() {
	return <span aria-hidden style={{ width: 1, height: 20, background: "var(--border)" }} />;
}

/** The ordered set of logos rendered once per marquee copy. */
function items(): ReactNode[] {
	const out: ReactNode[] = [];
	PROVS.forEach(([id, label], i) => {
		out.push(<ProvChip key={`p-${id}`} id={id} label={label} />);
		if (i < PROVS.length - 1) out.push(<Sep key={`ps-${id}`} />);
	});
	out.push(<Sep key="mid" />);
	INTEGRATIONS.forEach((id) => {
		out.push(
			<IntegrationLogo key={`i-${id}`} id={id} size={20} className="grayscale opacity-[0.55]" />,
		);
	});
	return out;
}

const rowStyle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 28 };

/**
 * RunsMarquee — a slow, grayscale, edge-masked marquee of the clouds and
 * integrations Alethia runs on. The track holds two identical copies and
 * translates -50% for a seamless loop; pausing on hover. Under
 * `prefers-reduced-motion` it collapses to a single static, wrapping row.
 */
export function RunsMarquee() {
	const reduced = usePrefersReducedMotion();
	const row = items();

	return (
		<section
			style={{
				// Only a top hairline: the following Keyless SectionShell supplies the
				// bottom divider, so the marquee rail flows into the sunken "Own it"
				// beat as one band instead of stacking a double border at the seam.
				borderTop: "1px solid var(--border)",
				background: "var(--surface-sunken)",
				padding: "26px 0",
				overflow: "hidden",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 28, maxWidth: 1160, margin: "0 auto", padding: "0 32px" }}>
				<span
					style={{
						...mono,
						fontSize: 10,
						letterSpacing: "0.18em",
						textTransform: "uppercase",
						color: "var(--text-tertiary)",
						flexShrink: 0,
						lineHeight: 1.4,
					}}
				>
					Runs on
					<br />
					your cloud
				</span>
				<span aria-hidden style={{ width: 1, height: 24, background: "var(--border)", flexShrink: 0 }} />

				{reduced ? (
					<div style={{ display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap" }}>
						{row}
					</div>
				) : (
					<div
						className="ah-marquee"
						style={{ position: "relative", flex: 1, overflow: "hidden", WebkitMaskImage: "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)", maskImage: "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)" }}
					>
						<div className="ah-marquee-track" style={{ display: "flex", width: "max-content" }}>
							<span style={{ ...rowStyle, paddingRight: 28 }}>{row}</span>
							<span aria-hidden style={{ ...rowStyle, paddingRight: 28 }}>{items()}</span>
						</div>
					</div>
				)}
			</div>
		</section>
	);
}
