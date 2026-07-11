// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { disp, Icon, type IconKey, mono, SecMark, Wrap } from "./primitives";

interface Guarantee {
	ic: IconKey;
	title: string;
	body: string;
	tag: string;
}

const GUARANTEES: Guarantee[] = [
	{
		ic: "layers",
		title: "Its own container",
		body: "Each job runs in a fresh per-job container with its own process namespace — it can't read the runner's memory or /proc.",
		tag: "per-job sandbox",
	},
	{
		ic: "key",
		title: "No shared secrets",
		body: "Only the short-lived credentials the job needs. A fail-closed guard refuses to start if any platform secret would leak in.",
		tag: "allowlist + fail-closed",
	},
	{
		ic: "shield",
		title: "No cloud metadata",
		body: "The job has no network route of its own, so the cloud metadata service — which holds boot config — is unreachable.",
		tag: "default-deny",
	},
	{
		ic: "route",
		title: "Allowlisted egress",
		body: "Reaches only the registries, Git hosts, and your cloud's API. Everything else is denied by default.",
		tag: "domain allowlist",
	},
];

/** 04 · Isolated execution — bring-your-own code runs sealed off on the managed fleet. */
export function IsolatedExecution() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="04" label="Isolated execution" />
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 36 }}>
					<h2 style={{ ...disp, fontSize: 38, fontWeight: 600, letterSpacing: "-0.035em", margin: 0, maxWidth: 600, color: "var(--text-primary)" }}>Bring your own infrastructure. Run it sealed off.</h2>
					<p style={{ fontSize: 15, color: "var(--text-tertiary)", maxWidth: 380, margin: 0, lineHeight: 1.6 }}>When we run your Terraform or Helm on the managed fleet, each job executes in its own sandbox — no shared secrets, no cloud metadata, only the egress it needs.</p>
				</div>
				<div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }} className="ah-4col">
					{GUARANTEES.map((g) => (
						<div key={g.title} style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", padding: 20 }}>
							<span style={{ display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface-muted)", color: "var(--text-secondary)", marginBottom: 16 }}><Icon k={g.ic} size={18} /></span>
							<h3 style={{ ...disp, fontSize: 15.5, fontWeight: 600, margin: "0 0 6px", color: "var(--text-primary)" }}>{g.title}</h3>
							<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", margin: "0 0 16px", lineHeight: 1.55 }}>{g.body}</p>
							<span style={{ ...mono, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-xs)", padding: "2px 7px" }}>{g.tag}</span>
						</div>
					))}
				</div>
			</Wrap>
		</section>
	);
}
