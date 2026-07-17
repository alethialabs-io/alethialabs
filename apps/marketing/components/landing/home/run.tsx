// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { disp, eyebrow, ExampleTag, Icon, JobsTable, JOBS, mono, SecMark, Wrap } from "./primitives";

const FLOW: [string, string][] = [
	["Author a Project", "Eleven guided sections — network, cluster, databases, caches, DNS, secrets."],
	["Compile & plan", "Sections compile to one OpenTofu plan; the gate verifies it before apply."],
	["Run as jobs", "Apply queues a job; a sandboxed runner executes it and streams logs back."],
	["Reconcile", "ArgoCD keeps every cluster matching Git. Drift is corrected automatically."],
];

const GUARANTEES: [string, string, string][] = [
	["Its own container", "A fresh per-job container with its own process namespace — it can't read the runner's memory or /proc.", "per-job sandbox"],
	["No shared secrets", "Only the short-lived credentials the job needs. A fail-closed guard refuses to start if a platform secret would leak in.", "allowlist + fail-closed"],
	["No cloud metadata", "The job has no network route of its own, so the cloud metadata service — which holds boot config — is unreachable.", "default-deny"],
	["Allowlisted egress", "Reaches only the registries, Git hosts, and your cloud's API. Everything else is denied by default.", "domain allowlist"],
];

/** 05 · Run — the lifecycle from a saved Project to a reconciled cluster, sandboxed. */
export function Run() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="05" label="Run" />
				<h2 style={{ ...disp, fontSize: 38, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 14px", maxWidth: 640, color: "var(--text-primary)" }}>From a saved Project to a reconciled cluster — sealed off.</h2>
				<p style={{ fontSize: 15.5, color: "var(--text-tertiary)", maxWidth: 580, margin: "0 0 40px", lineHeight: 1.6 }}>Apply a Project and the platform compiles it, verifies it, queues a job, and runs it on a runner — each job in its own sandbox — then hands the cluster to GitOps. Every step is streamed and auditable.</p>

				{/* lifecycle with a scroll-linked progress rail across the top */}
				<div className="ah-rail" style={{ position: "relative", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--surface)", marginBottom: 28 }}>
					<div aria-hidden style={{ position: "absolute", top: 0, left: 0, height: 2, width: "calc(var(--ah-progress) * 100%)", background: "var(--text-primary)", zIndex: 2 }} />
					<div className="ah-life" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)" }}>
						{FLOW.map(([title, desc], i) => (
							<div key={title} style={{ padding: "24px 22px 26px", borderLeft: i ? "1px solid var(--border)" : "none" }}>
								<div style={{ ...disp, fontSize: 26, fontWeight: 600, letterSpacing: "-0.03em", color: "var(--text-disabled)", lineHeight: 1, marginBottom: 16 }}>0{i + 1}</div>
								<h3 style={{ ...disp, fontSize: 16, fontWeight: 600, margin: "0 0 7px", color: "var(--text-primary)" }}>{title}</h3>
								<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", lineHeight: 1.55, margin: 0 }}>{desc}</p>
							</div>
						))}
					</div>
				</div>

				<div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 12px" }}>
					<span style={{ ...eyebrow, fontSize: 9.5 }}>Jobs</span>
					<span style={{ flex: 1, height: 1, background: "var(--border-faint)" }} />
					<ExampleTag />
				</div>
				<JobsTable rows={JOBS} />

				{/* isolation guarantees — text-led, no icon tiles */}
				<div style={{ ...eyebrow, fontSize: 9.5, margin: "40px 0 12px" }}>Every job runs sealed off</div>
				<div className="ah-4col" style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--surface)" }}>
					{GUARANTEES.map(([title, body, tag], i) => (
						<div key={title} style={{ padding: "20px 20px 22px", borderLeft: i ? "1px solid var(--border)" : "none" }}>
							<h3 style={{ ...disp, fontSize: 14.5, fontWeight: 600, margin: "0 0 8px", color: "var(--text-primary)" }}>{title}</h3>
							<p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "0 0 14px", lineHeight: 1.55 }}>{body}</p>
							<span style={{ ...mono, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-secondary)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-xs)", padding: "2px 7px" }}>{tag}</span>
						</div>
					))}
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 16, ...mono, fontSize: 11, color: "var(--text-tertiary)" }}>
					<Icon k="shield" size={13} sw={1.7} />
					<span>Bring your own Terraform or Helm — we run it on the managed fleet without ever holding your keys.</span>
				</div>
			</Wrap>
		</section>
	);
}
