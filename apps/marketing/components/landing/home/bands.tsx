// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { disp, eyebrow, Icon, mono, SecMark, Wrap } from "./primitives";

/** Section heading (eyebrow marker + title + lede), shared by the typographic bands. */
function Heading({ n, label, title, lede }: { n: string; label: string; title: string; lede: string }) {
	return (
		<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 40 }}>
			<div>
				<SecMark n={n} label={label} />
				<h2 style={{ ...disp, fontSize: 38, fontWeight: 600, letterSpacing: "-0.035em", margin: 0, maxWidth: 560, color: "var(--text-primary)", lineHeight: 1.08 }}>{title}</h2>
			</div>
			<p style={{ fontSize: 15, color: "var(--text-tertiary)", maxWidth: 420, margin: 0, lineHeight: 1.6 }}>{lede}</p>
		</div>
	);
}

const PROVE_STEPS: [string, string, string][] = [
	["01", "Plan", "Your Project compiles to an OpenTofu plan — a precise, reviewable summary of exactly what will change."],
	["02", "Verify · fail-closed", "A deterministic gate runs over the plan before anything executes: keyless, least-privilege, no public data stores. If a control can't be evaluated, it denies."],
	["03", "Receipt", "Every approved apply carries a signed, ed25519 evidence receipt — the plan hash, the controls, the verdict. Prove it once, then keep proving it as drift is caught."],
];

/** The prove-it wedge — the deterministic gate + signed receipt, told typographically. */
export function ProveBand() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<Heading
					n="04"
					label="Verification"
					title="Prove it. Then keep proving it."
					lede="Generation isn't the hard part — proof is. Between plan and apply, Alethia verifies the plan, and every apply leaves portable, cryptographic evidence."
				/>
				<div className="ah-3col" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 0, border: "1px solid var(--border)", overflow: "hidden", background: "var(--surface)" }}>
					{PROVE_STEPS.map(([num, title, body], i) => (
						<div key={num} style={{ padding: "26px 24px 30px", borderLeft: i ? "1px solid var(--border)" : "none" }}>
							<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
								<span style={{ ...mono, fontSize: 11, color: "var(--text-disabled)", letterSpacing: "0.1em" }}>{num}</span>
								<span style={{ width: 20, height: 1, background: "var(--border-strong)" }} />
								<span style={{ ...eyebrow, fontSize: 9.5 }}>{title}</span>
							</div>
							<p style={{ fontSize: 13.5, color: "var(--text-tertiary)", lineHeight: 1.6, margin: 0 }}>{body}</p>
						</div>
					))}
				</div>
				<div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 20, ...mono, fontSize: 11, color: "var(--text-tertiary)" }}>
					<Icon k="lock" size={13} sw={1.7} />
					<span>The LLM proposes; the deterministic gate disposes. Verdicts are reproducible given the same plan — reported hygiene, never over-claimed.</span>
				</div>
			</Wrap>
		</section>
	);
}

const DIFFERENTIATORS: [string, string][] = [
	["You hold the keys — we hold none", "Other control planes run your infrastructure on their servers, holding your cloud credentials. Alethia provisions into accounts you own, through short-lived federated identity, and holds zero static keys."],
	["Proof, not just generation", "Agents that ship fast are table stakes. Alethia emits a signed, portable receipt for every apply — evidence you can verify offline, long after the run."],
	["One control plane, infra and apps", "From the cluster to the workloads that run on it: one keyless posture, one proof chain, one drift signal — that you can self-host."],
];

/** Positioning band — own-it + keyless + prove-it; counter to key-holding platforms. */
export function PositioningBand() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<Heading
					n="06"
					label="Why Alethia"
					title="Guardrails that hold zero keys."
					lede="Verified, evidence-backed, keyless provisioning and delivery — that you own. Not rented, not key-holding."
				/>
				<div className="ah-3col" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
					{DIFFERENTIATORS.map(([title, body]) => (
						<div key={title} style={{ border: "1px solid var(--border)", background: "var(--surface)", padding: "24px 22px" }}>
							<h3 style={{ ...disp, fontSize: 16.5, fontWeight: 600, margin: "0 0 9px", color: "var(--text-primary)", lineHeight: 1.25 }}>{title}</h3>
							<p style={{ fontSize: 13.5, color: "var(--text-tertiary)", lineHeight: 1.6, margin: 0 }}>{body}</p>
						</div>
					))}
				</div>
			</Wrap>
		</section>
	);
}

const COMING: [string, string][] = [
	["Service & workload model", "First-class services on the canvas — image, env, secrets, probes, and edges to your backing infra."],
	["Build & push from your repo", "A Dockerfile becomes an image in your registry, wired into the service, keyless."],
	["Generate from a repo scan", "Point Elench at a repository; it proposes a ready-to-shape Project."],
];

/** Honest roadmap band — clearly-labeled "coming", per demos/DEMO-READINESS.md. */
export function RoadmapBand() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<Heading
					n="09"
					label="Roadmap"
					title="Where this is going."
					lede="We ship honestly. These are in progress — shown here so you know what's real today and what's next."
				/>
				<div className="ah-3col" style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
					{COMING.map(([title, body]) => (
						<div key={title} style={{ border: "1px dashed var(--border-strong)", background: "var(--surface)", padding: "24px 22px" }}>
							<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
								<h3 style={{ ...disp, fontSize: 15.5, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>{title}</h3>
								<span style={{ ...mono, fontSize: 9, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-tertiary)", border: "1px solid var(--border-strong)", padding: "2px 7px" }}>Coming</span>
							</div>
							<p style={{ fontSize: 13, color: "var(--text-tertiary)", lineHeight: 1.6, margin: 0 }}>{body}</p>
						</div>
					))}
				</div>
			</Wrap>
		</section>
	);
}
