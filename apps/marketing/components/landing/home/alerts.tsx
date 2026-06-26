// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusBadge } from "@repo/ui/status-badge";
import { disp, Icon, type IconKey, mono, SecMark, Wrap } from "./primitives";

const POLICIES: [string, string, number][] = [
	["Job failed", "Any apply or destroy fails", 2],
	["Runner offline", "A runner misses 3 heartbeats", 2],
	["Cost threshold", "A Spec exceeds its monthly budget", 1],
];

const CHANNELS: [IconKey, string, string, string][] = [
	["route", "PagerDuty", "on-call · critical", "active"],
	["bell", "Slack #ops", "all events", "active"],
	["jobs", "Email digest", "daily summary", "active"],
	["git", "Webhook", "https://hooks.acme…", "idle"],
];

/** 06 · Alerts & channels — policies match events, channels deliver them. */
export function Alerts() {
	return (
		<section style={{ padding: "84px 0", borderTop: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<SecMark n="06" label="Alerts & channels" />
				<div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 24, flexWrap: "wrap", marginBottom: 40 }}>
					<h2 style={{ ...disp, fontSize: 38, fontWeight: 600, letterSpacing: "-0.035em", margin: 0, maxWidth: 520, color: "var(--text-primary)" }}>What fires, where it goes, what happened.</h2>
					<p style={{ fontSize: 15, color: "var(--text-tertiary)", maxWidth: 380, margin: 0, lineHeight: 1.6 }}>Policies match events. Channels deliver them. Activity is the record — all in one place.</p>
				</div>
				<div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 16 }} className="ah-2col">
					{/* policies */}
					<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", overflow: "hidden" }}>
						<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
							<Icon k="bell" size={15} /><span style={{ ...disp, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Policies</span>
							<span style={{ ...mono, fontSize: 10, color: "var(--text-tertiary)", marginLeft: "auto" }}>3 active</span>
						</div>
						{POLICIES.map(([name, match, ch], i) => (
							<div key={name} style={{ padding: "14px 16px", borderBottom: i < POLICIES.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
								<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
									<span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--text-primary)", flexShrink: 0 }} />
									<span style={{ fontSize: 13.5, fontWeight: 600, ...disp, color: "var(--text-primary)", whiteSpace: "nowrap" }}>{name}</span>
									<span style={{ marginLeft: "auto", ...mono, fontSize: 10, color: "var(--text-tertiary)", whiteSpace: "nowrap", flexShrink: 0 }}>→ {ch} {ch === 1 ? "channel" : "channels"}</span>
								</div>
								<p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "0 0 0 17px" }}>{match}</p>
							</div>
						))}
					</div>
					{/* channels */}
					<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", overflow: "hidden" }}>
						<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
							<Icon k="route" size={15} /><span style={{ ...disp, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Channels</span>
							<span style={{ ...mono, fontSize: 10, color: "var(--text-tertiary)", marginLeft: "auto" }}>4 configured</span>
						</div>
						{CHANNELS.map(([ic, name, meta, st], i) => (
							<div key={name} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderBottom: i < CHANNELS.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
								<span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface-sunken)", color: "var(--text-secondary)", flexShrink: 0 }}><Icon k={ic} size={14} /></span>
								<div style={{ minWidth: 0 }}>
									<div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{name}</div>
									<div style={{ ...mono, fontSize: 10.5, color: "var(--text-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{meta}</div>
								</div>
								<span style={{ marginLeft: "auto" }}><StatusBadge status={st} /></span>
							</div>
						))}
					</div>
				</div>
			</Wrap>
		</section>
	);
}
