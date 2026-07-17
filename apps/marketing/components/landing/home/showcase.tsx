// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { disp, Icon, SecMark, Wrap } from "./primitives";
import { MediaShot } from "./media-shot";

/**
 * A product section: copy on the left, a REAL captured console screenshot on the
 * right. Every image is an authentic capture — the structural honesty rule.
 */
export function Showcase({
	n,
	label,
	title,
	body,
	points,
	src,
	alt,
	muted,
}: {
	n: string;
	label: string;
	title: string;
	body: string;
	points?: string[];
	src: string;
	alt: string;
	muted?: boolean;
}) {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)", background: muted ? "var(--surface-sunken)" : undefined }}>
			<Wrap>
				<div className="ah-surface" style={{ display: "grid", gridTemplateColumns: "0.85fr 1.15fr", gap: 56, alignItems: "center" }}>
					<div>
						<SecMark n={n} label={label} />
						<h2 style={{ ...disp, fontSize: 33, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 15px", color: "var(--text-primary)", lineHeight: 1.1 }}>{title}</h2>
						<p style={{ fontSize: 15.5, color: "var(--text-tertiary)", lineHeight: 1.65, margin: 0, maxWidth: 440 }}>{body}</p>
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
					<MediaShot src={src} alt={alt} />
				</div>
			</Wrap>
		</section>
	);
}
