// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { disp, eyebrow, Icon, mono, Wrap } from "./primitives";

const CLOUDS = ["Hetzner", "GCP", "AWS", "Azure", "Alibaba"];

/** Open-source teaser band — links the dedicated /open-source page. */
export function OpenSource() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<div
					className="ah-surface"
					style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 56, alignItems: "center", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", background: "var(--surface-sunken)", padding: "40px 44px" }}
				>
					<div>
						<p style={{ ...eyebrow, marginBottom: 16 }}>Open source · AGPL-3.0</p>
						<h2 style={{ ...disp, fontSize: 32, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 14px", color: "var(--text-primary)" }}>
							Yours to run.
						</h2>
						<p style={{ fontSize: 15, color: "var(--text-tertiary)", lineHeight: 1.65, margin: "0 0 22px", maxWidth: 420 }}>
							Alethia is open source. Self-host the whole control plane on your own
							infrastructure — closed-origin behind a Cloudflare Tunnel, on any of five clouds. We
							host nothing.
						</p>
						<Link href="/open-source" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--text-primary)", borderBottom: "1px solid var(--border-strong)", paddingBottom: 3, textDecoration: "none" }}>
							Explore open source <Icon k="arrow" size={14} />
						</Link>
					</div>
					<div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
						{CLOUDS.map((c) => (
							<span key={c} style={{ ...mono, fontSize: 12, color: "var(--text-secondary)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "7px 12px", background: "var(--surface)" }}>
								{c}
							</span>
						))}
					</div>
				</div>
			</Wrap>
		</section>
	);
}
