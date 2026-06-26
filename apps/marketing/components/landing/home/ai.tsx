// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	AgentThread,
	AskActRow,
	disp,
	eyebrow,
	Icon,
	type IconKey,
	mono,
	Prov,
	type ProviderId,
	SecMark,
	Wrap,
} from "./primitives";

const NEEDS = ["Postgres", "Redis", "Object storage"];

const COMPARE: [ProviderId, string, string, boolean][] = [
	["aws", "AWS", "$312", true],
	["gcp", "GCP", "$341", false],
	["azure", "Azure", "$329", false],
];

const TOOLS: [IconKey, string, string][] = [
	["sparkles", "19 tools", "list_specs · list_jobs · list_runners · scan_repo · propose_operation. One tool layer drives the console, the CLI, and the agent."],
	["plug", "MCP server", "The same tools, exposed to Claude over MCP — operate Alethia from Claude Code or claude.ai."],
	["scan", "Repo scanner", "Point it at a repo; it infers the stack and returns a ready-to-deploy Spec with a cost estimate."],
];

/** 05 · AI — an agent that reads your infrastructure through the same tools. */
export function AI() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="05" label="AI" />
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 36 }}>
					<h2 style={{ ...disp, fontSize: 38, fontWeight: 600, letterSpacing: "-0.035em", margin: 0, maxWidth: 580, color: "var(--text-primary)" }}>An agent that understands your infrastructure.</h2>
					<p style={{ fontSize: 15, color: "var(--text-tertiary)", maxWidth: 400, margin: 0, lineHeight: 1.6 }}>It reads your specs, jobs, clusters, and costs through the same tools the console uses. Ask in read-only mode; in act mode it proposes operations you approve — it never provisions on its own.</p>
				</div>
				<div style={{ display: "grid", gridTemplateColumns: "1.05fr 0.95fr", gap: 16, alignItems: "stretch" }} className="ah-2col">
					{/* agent panel */}
					<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", overflow: "hidden", display: "flex", flexDirection: "column" }}>
						<div style={{ display: "flex", alignItems: "center", gap: 9, padding: "13px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
							<Icon k="sparkles" size={15} /><span style={{ ...disp, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Agent</span>
							<span style={{ ...mono, fontSize: 10, color: "var(--text-tertiary)", marginLeft: "auto" }}>orders-api · thread</span>
						</div>
						<div style={{ padding: 18, flex: 1 }}><AgentThread /></div>
					</div>
					{/* right column */}
					<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
						<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", overflow: "hidden" }}>
							<AskActRow ic="book" title="Ask — read-only" body="Query specs, jobs, clusters, connectors, and costs. The agent answers from live state, never guessing." />
							<AskActRow ic="check" title="Act — you approve" body="It proposes plan and apply operations as cards. Nothing runs until you click approve." />
						</div>
						<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", overflow: "hidden", flex: 1 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
								<Icon k="scan" size={15} /><span style={{ ...disp, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Repo scanner</span>
								<span style={{ ...mono, fontSize: 10, color: "var(--text-tertiary)", marginLeft: "auto" }}>repo → Spec</span>
							</div>
							<div style={{ padding: "14px 16px" }}>
								<div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
									<Icon k="git" size={13} sw={1.7} /><code style={{ ...mono, fontSize: 11.5, color: "var(--text-secondary)" }}>github.com/acme/orders-api</code>
								</div>
								<div style={{ ...eyebrow, fontSize: 8.5, marginBottom: 7 }}>Inferred needs</div>
								<div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
									{NEEDS.map((n) => (
										<span key={n} style={{ fontSize: 11.5, color: "var(--text-primary)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-xs)", padding: "3px 9px", background: "var(--surface-muted)" }}>{n}</span>
									))}
								</div>
								<div style={{ ...eyebrow, fontSize: 8.5, marginBottom: 7 }}>Estimated · same Spec, each cloud</div>
								<div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
									{COMPARE.map(([id, label, val, best]) => (
										<div key={id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
											<Prov id={id} size={14} /><span style={{ fontSize: 12, color: "var(--text-secondary)", width: 44 }}>{label}</span>
											<span style={{ flex: 1, height: 1, background: "var(--border-faint)" }} />
											{best && <span style={{ ...mono, fontSize: 8.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>best</span>}
											<span style={{ ...mono, fontSize: 12, color: best ? "var(--text-primary)" : "var(--text-tertiary)", fontWeight: best ? 600 : 400 }}>{val}/mo</span>
										</div>
									))}
								</div>
							</div>
						</div>
					</div>
				</div>
				{/* tool strip */}
				<div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden", background: "var(--surface)", marginTop: 16 }} className="ah-3col">
					{TOOLS.map(([ic, title, body], i) => (
						<div key={title} style={{ padding: "20px 22px", borderLeft: i ? "1px solid var(--border)" : "none" }}>
							<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
								<span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: "var(--radius-md)", border: "1px solid var(--border)", background: "var(--surface-muted)", color: "var(--text-primary)" }}><Icon k={ic} size={16} /></span>
								<span style={{ ...disp, fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>{title}</span>
							</div>
							<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", lineHeight: 1.55, margin: 0 }}>{body}</p>
						</div>
					))}
				</div>
			</Wrap>
		</section>
	);
}
