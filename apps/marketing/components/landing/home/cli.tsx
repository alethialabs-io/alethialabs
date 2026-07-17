"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from "react";
import { disp, Icon, mono, SecMark, Wrap } from "./primitives";
import { LiveTerminal } from "./live-terminal";

const CMDS: [string, string][] = [
	["login", "Device-flow auth · no stored keys"],
	["project plan", "Compile a Project → OpenTofu plan"],
	["project apply", "Queue an apply across your cloud"],
	["agent", "Ask or act from your shell"],
	["scan", "Repo → proposed Project + cost"],
	["jobs logs", "Stream a running job live"],
	["runner list", "Inspect the runner fleet"],
	["project destroy", "Tear a Project down safely"],
];

const INSTALL = "brew install alethialabs-io/tap/alethia";

/** 08 · alethia CLI — the terminal is the deploy button. */
export function Cli() {
	const [copied, setCopied] = useState(false);
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<SecMark n="08" label="alethia CLI" />
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 48, alignItems: "center", marginBottom: 48 }} className="ah-surface">
					<div>
						<h2 style={{ ...disp, fontSize: 34, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 14px", color: "var(--text-primary)" }}>The terminal is the deploy button.</h2>
						<p style={{ fontSize: 15, color: "var(--text-tertiary)", lineHeight: 1.65, margin: "0 0 22px", maxWidth: 440 }}>One CLI for auth, projects, jobs, runners, clusters — plus the agent and repo scanner. The CLI and the console share one state, so you can script it, pipe it, and run it in CI.</p>
						<button
							type="button"
							onClick={() => {
								void navigator.clipboard?.writeText(INSTALL);
								setCopied(true);
								setTimeout(() => setCopied(false), 1500);
							}}
							style={{ display: "inline-flex", alignItems: "center", gap: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "11px 16px", cursor: "pointer", background: "var(--surface)", fontFamily: "inherit" }}
						>
							<code style={{ ...mono, fontSize: 14, color: "var(--text-primary)" }}><span style={{ color: "var(--text-tertiary)" }}>$ </span>{INSTALL}</code>
							<span style={{ color: copied ? "var(--text-primary)" : "var(--text-tertiary)", display: "flex" }}><Icon k={copied ? "check" : "copy"} size={15} /></span>
						</button>
					</div>
					<LiveTerminal height={300} />
				</div>
				<div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 0, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", overflow: "hidden", background: "var(--surface)" }} className="ah-cmds">
					{CMDS.map(([c, d], i) => (
						<div key={c} style={{ padding: "18px 18px", borderLeft: i % 4 ? "1px solid var(--border)" : "none", borderTop: i >= 4 ? "1px solid var(--border)" : "none" }}>
							<code style={{ ...mono, fontSize: 13, color: "var(--text-primary)" }}><span style={{ color: "var(--text-tertiary)" }}>$ alethia </span>{c}</code>
							<p style={{ fontSize: 11.5, color: "var(--text-tertiary)", lineHeight: 1.5, margin: "10px 0 0" }}>{d}</p>
						</div>
					))}
				</div>
			</Wrap>
		</section>
	);
}
