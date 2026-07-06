// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { disp, eyebrow, Icon, type IconKey, JobsTable, JOBS, mono, SecMark, Wrap } from "./primitives";

const FLOW: [IconKey, string, string][] = [
	["layers", "Author a Project", "Eleven guided sections — network, cluster, databases, caches, DNS, secrets."],
	["gauge", "Compile & plan", "Sections compile to one OpenTofu plan with a live monthly estimate."],
	["jobs", "Run as jobs", "Apply queues a job; a runner executes it and streams logs back."],
	["git", "Reconcile", "ArgoCD keeps every cluster matching Git. Drift is corrected automatically."],
];

/** 03 · Projects → jobs — the lifecycle from a saved Project to a reconciled cluster. */
export function ProjectsJobs() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="03" label="Projects → jobs" />
				<h2 style={{ ...disp, fontSize: 38, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 14px", maxWidth: 620, color: "var(--text-primary)" }}>From a saved Project to a reconciled cluster.</h2>
				<p style={{ fontSize: 15.5, color: "var(--text-tertiary)", maxWidth: 560, margin: "0 0 44px", lineHeight: 1.6 }}>Apply a Project and the platform compiles it, queues a job, runs it on a runner, and hands the cluster to GitOps — every step streamed and auditable.</p>
				<div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 0, border: "1px solid var(--border)", marginBottom: 28, background: "var(--surface)", borderRadius: "var(--radius-md)", overflow: "hidden" }} className="ah-life">
					{FLOW.map(([ic, title, desc], i) => (
						<div key={title} style={{ padding: "22px 22px 26px", borderLeft: i ? "1px solid var(--border)" : "none", position: "relative" }}>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
								<span style={{ ...mono, fontSize: 11, color: "var(--text-disabled)" }}>0{i + 1}</span>
								<span style={{ display: "grid", placeItems: "center", width: 34, height: 34, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--surface-muted)", color: "var(--text-primary)" }}><Icon k={ic} size={16} /></span>
							</div>
							<h3 style={{ ...disp, fontSize: 16, fontWeight: 600, margin: "0 0 7px", color: "var(--text-primary)" }}>{title}</h3>
							<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", lineHeight: 1.55, margin: 0 }}>{desc}</p>
						</div>
					))}
				</div>
				<div style={{ ...eyebrow, fontSize: 9.5, margin: "0 0 12px" }}>Jobs · live</div>
				<JobsTable rows={JOBS} />
			</Wrap>
		</section>
	);
}
