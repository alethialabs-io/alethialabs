// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { disp, Icon, mono, PoolList, SecMark, Wrap } from "./primitives";

/** 04 · Self-healing runners — warm pools the controller keeps sized. */
export function FleetTeaser() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1.15fr", gap: 56, alignItems: "center" }} className="ah-surface">
					<div>
						<SecMark n="04" label="Self-healing runners" />
						<h2 style={{ ...disp, fontSize: 34, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 14px", color: "var(--text-primary)" }}>Warm pools that keep themselves sized.</h2>
						<p style={{ fontSize: 15, color: "var(--text-tertiary)", lineHeight: 1.65, margin: "0 0 22px", maxWidth: 440 }}>A controller keeps a warm pool of runners per cloud, replaces dead VMs, and rolls out new versions with zero downtime — never dropping below the warm floor. Self-hosted in your account, or cloud-hosted by us.</p>
						<Link href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--text-primary)", borderBottom: "1px solid var(--border-strong)", paddingBottom: 3, textDecoration: "none" }}>Open the Fleet dashboard <Icon k="arrow" size={14} /></Link>
					</div>
					<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", boxShadow: "var(--shadow-md)", overflow: "hidden" }}>
						<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
							<span style={{ ...disp, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Fleet</span>
							<span style={{ ...mono, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>3 pools · 11 online</span>
						</div>
						<PoolList />
					</div>
				</div>
			</Wrap>
		</section>
	);
}
