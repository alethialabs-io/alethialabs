// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusBadge } from "@repo/ui/status-badge";
import { disp, eyebrow, ExampleTag, Icon, mono, SecMark, Wrap } from "./primitives";

/** Illustrative elench controls — all passing for the shown plan (6 controls). */
const CONTROLS: string[] = [
	"Keyless — no static credentials",
	"OIDC subject bound to repo",
	"No public ingress on data stores",
	"Region allowlist · eu-west",
	"Encryption at rest",
	"Budget ceiling",
];

/** Stage column header — "01 · Plan". */
function Stage({ n, label, note, children }: { n: string; label: string; note: string; children: React.ReactNode }) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "22px 22px 24px", position: "relative", background: "var(--surface)" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 11 }}>
				<span style={{ ...mono, fontSize: 11, color: "var(--text-disabled)", letterSpacing: "0.1em" }}>{n}</span>
				<span style={{ width: 18, height: 1, background: "var(--border-strong)" }} />
				<span style={{ ...eyebrow, fontSize: 9.5 }}>{label}</span>
			</div>
			<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", margin: 0, lineHeight: 1.55 }}>{note}</p>
			{children}
		</div>
	);
}

/** 04 · Verification — the fail-closed elench gate: plan → policy → signed receipt. */
export function Verify() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="04" label="Verification" />
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 36 }}>
					<h2 style={{ ...disp, fontSize: 38, fontWeight: 600, letterSpacing: "-0.035em", margin: 0, maxWidth: 560, color: "var(--text-primary)" }}>Prove it. Then keep proving it.</h2>
					<p style={{ fontSize: 15, color: "var(--text-tertiary)", maxWidth: 420, margin: 0, lineHeight: 1.6 }}>Between plan and apply, a deterministic policy gate runs over the OpenTofu plan. It is fail-closed — if a control cannot be evaluated, the gate denies — and every approved apply carries an ed25519-signed receipt.</p>
				</div>

				{/* three-stage rail with a scroll-linked scan sweep */}
				<div
					className="ah-scan"
					style={{ position: "relative", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", overflow: "hidden", background: "var(--surface-sunken)" }}
				>
					<div
						aria-hidden
						style={{ position: "absolute", top: 0, bottom: 0, left: "var(--ah-scan)", width: 2, background: "color-mix(in oklch, var(--text-primary) 55%, transparent)", boxShadow: "0 0 0 0.5px color-mix(in oklch, var(--text-primary) 22%, transparent)", pointerEvents: "none", zIndex: 2 }}
					/>
					<div className="ah-3col" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", position: "relative", zIndex: 1 }}>
						{/* Plan */}
						<div style={{ borderRight: "1px solid var(--border)" }}>
							<Stage n="01" label="Plan" note="The compiled OpenTofu plan — a change summary, resource by resource.">
								<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--surface-sunken)", padding: "12px 14px", ...mono, fontSize: 12 }}>
									<div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
										<span style={{ color: "var(--text-tertiary)" }}>orders-api · aws</span>
										<ExampleTag />
									</div>
									<div style={{ color: "var(--text-primary)" }}>47 to add</div>
									<div style={{ color: "var(--text-tertiary)" }}>0 change · 0 destroy</div>
								</div>
							</Stage>
						</div>
						{/* Gate */}
						<div style={{ borderRight: "1px solid var(--border)" }}>
							<Stage n="02" label="Verify · fail-closed" note="Deterministic controls evaluated against the plan before anything runs.">
								<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--surface)", overflow: "hidden" }}>
									{CONTROLS.map((c, i) => (
										<div key={c} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: i < CONTROLS.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
											<span style={{ fontSize: 12, color: "var(--text-secondary)", flex: 1, lineHeight: 1.35 }}>{c}</span>
											<StatusBadge status="active" tier="active" label="pass" />
										</div>
									))}
								</div>
							</Stage>
						</div>
						{/* Receipt */}
						<div>
							<Stage n="03" label="Receipt" note="A signed, verifiable record every apply carries — prove it once, prove it later.">
								<div style={{ border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", background: "var(--surface)", padding: "14px" }}>
									<div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
										<Icon k="shield" size={15} />
										<span style={{ ...disp, fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>Evidence receipt</span>
										<span style={{ marginLeft: "auto" }}><StatusBadge status="active" tier="active" label="verified" /></span>
									</div>
									<div style={{ ...mono, fontSize: 11, color: "var(--text-tertiary)", lineHeight: 1.7 }}>
										<div>alg <span style={{ color: "var(--text-secondary)" }}>ed25519</span></div>
										<div>sig <span style={{ color: "var(--text-secondary)" }}>9f3c2e…a71b</span></div>
										<div>controls <span style={{ color: "var(--text-secondary)" }}>6 / 6 pass</span></div>
									</div>
								</div>
								<p style={{ fontSize: 11.5, color: "var(--text-disabled)", margin: "12px 0 0", lineHeight: 1.5, display: "flex", alignItems: "center", gap: 7 }}>
									<Icon k="lock" size={12} sw={1.7} />Attached to the apply · re-verifiable offline
								</p>
							</Stage>
						</div>
					</div>
				</div>
			</Wrap>
		</section>
	);
}
