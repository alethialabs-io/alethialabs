// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusBadge } from "@/components/ui/status-badge";
import { disp, Icon, mono, Prov, type ProviderId, SecMark, Wrap } from "./primitives";

interface Conn {
	id: ProviderId;
	name: string;
	method: string;
	tag: string;
	connected: boolean;
}

const CONNS: Conn[] = [
	{ id: "aws", name: "AWS", method: "Cross-account IAM role", tag: "AssumeRole", connected: true },
	{ id: "gcp", name: "Google Cloud", method: "Workload Identity Federation", tag: "WIF", connected: true },
	{ id: "azure", name: "Azure", method: "Federated identity", tag: "OIDC", connected: false },
];

/** 01 · Zero-trust clouds — connect via short-lived federated identity. */
export function ZeroTrust() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="01" label="Zero-trust clouds" />
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 36 }}>
					<h2 style={{ ...disp, fontSize: 38, fontWeight: 600, letterSpacing: "-0.035em", margin: 0, maxWidth: 600, color: "var(--text-primary)" }}>Connect a cloud. Store nothing.</h2>
					<p style={{ fontSize: 15, color: "var(--text-tertiary)", maxWidth: 380, margin: 0, lineHeight: 1.6 }}>Every cloud connects through short-lived federated identity. No access keys are ever written to disk or held in our database.</p>
				</div>
				<div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }} className="ah-3col">
					{CONNS.map((c) => (
						<div key={c.id} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", padding: 20 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16 }}>
								<span style={{ display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface-muted)" }}><Prov id={c.id} size={20} /></span>
								<span style={{ marginLeft: "auto" }}>
									{c.connected ? <StatusBadge status="connected" label="Connected" /> : <StatusBadge status="idle" label="Not connected" />}
								</span>
							</div>
							<h3 style={{ ...disp, fontSize: 16, fontWeight: 600, margin: "0 0 5px", color: "var(--text-primary)" }}>{c.name}</h3>
							<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", margin: "0 0 16px", lineHeight: 1.5 }}>{c.method}</p>
							<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
								<span style={{ ...mono, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-xs)", padding: "2px 7px" }}>{c.tag}</span>
								<span style={{ ...mono, fontSize: 10.5, color: "var(--text-disabled)", display: "flex", alignItems: "center", gap: 5 }}><Icon k="lock" size={11} sw={1.7} />no static keys</span>
							</div>
						</div>
					))}
				</div>
			</Wrap>
		</section>
	);
}
