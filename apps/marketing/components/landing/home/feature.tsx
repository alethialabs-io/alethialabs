// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactNode } from "react";
import { disp, Icon, SecMark, Wrap } from "./primitives";

/**
 * A product section: copy on one side, a bespoke ANIMATED diagram on the other
 * (alternating sides). The diagram — not a screenshot — illustrates the concept.
 */
export function Feature({
	n,
	label,
	title,
	body,
	points,
	visual,
	reverse,
	muted,
}: {
	n: string;
	label: string;
	title: string;
	body: string;
	points?: string[];
	visual: ReactNode;
	reverse?: boolean;
	muted?: boolean;
}) {
	const text = (
		<div>
			<SecMark n={n} label={label} />
			<h2 style={{ ...disp, fontSize: 33, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 15px", color: "var(--text-primary)", lineHeight: 1.1 }}>{title}</h2>
			<p style={{ fontSize: 15.5, color: "var(--text-tertiary)", lineHeight: 1.65, margin: 0, maxWidth: 430 }}>{body}</p>
			{points && points.length > 0 && (
				<ul style={{ listStyle: "none", padding: 0, margin: "22px 0 0", display: "flex", flexDirection: "column", gap: 12 }}>
					{points.map((p) => (
						<li key={p} style={{ display: "flex", alignItems: "flex-start", gap: 11, fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.5 }}>
							<span style={{ marginTop: 2, color: "var(--text-primary)", flexShrink: 0 }}><Icon k="check" size={15} sw={2} /></span>
							{p}
						</li>
					))}
				</ul>
			)}
		</div>
	);
	const viz = <div style={{ display: "flex", justifyContent: "center", alignItems: "center" }}>{visual}</div>;

	return (
		<section style={{ padding: "90px 0", borderTop: "1px solid var(--border)", background: muted ? "var(--surface-sunken)" : undefined }}>
			<Wrap>
				<div className="ah-surface" style={{ display: "grid", gridTemplateColumns: reverse ? "1.1fr 0.9fr" : "0.9fr 1.1fr", gap: 64, alignItems: "center" }}>
					{reverse ? (
						<>
							{viz}
							{text}
						</>
					) : (
						<>
							{text}
							{viz}
						</>
					)}
				</div>
			</Wrap>
		</section>
	);
}
