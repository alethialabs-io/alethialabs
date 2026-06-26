"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { type ReactNode, useState } from "react";
import { Button } from "@repo/ui/button";
import { Badge } from "@repo/ui/badge";
import {
	AgentThread,
	disp,
	eyebrow,
	HeroRail,
	Icon,
	type IconKey,
	JobsTable,
	JOBS,
	Mark,
	mono,
	PoolList,
	Wrap,
} from "./primitives";
import { LiveTerminal } from "./live-terminal";

const SLIM_NAV: IconKey[] = ["grid", "node", "sparkles", "server", "jobs", "bell", "shield"];

/** Outline mono pill used across the page (badge with optional leading node). */
function Pill({ children }: { children: ReactNode }) {
	return (
		<Badge variant="outline" className="rounded-sm font-mono text-[10px] uppercase tracking-wider text-text-tertiary">
			{children}
		</Badge>
	);
}

/** Faux browser chrome with a left nav rail — frames the console mocks. */
function BrowserFrame({ url, children, height = 396 }: { url: string; children: ReactNode; height?: number }) {
	return (
		<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", overflow: "hidden", background: "var(--surface)", boxShadow: "var(--shadow-lg)" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
				<div style={{ display: "flex", gap: 6 }}>
					{[0, 1, 2].map((i) => <span key={i} style={{ width: 10, height: 10, borderRadius: 999, border: "1px solid var(--border-strong)" }} />)}
				</div>
				<div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
					<div style={{ display: "flex", alignItems: "center", gap: 7, padding: "4px 14px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface-sunken)", ...mono, fontSize: 11, color: "var(--text-tertiary)" }}>
						<Icon k="lock" size={11} sw={1.7} />{url}
					</div>
				</div>
				<div style={{ width: 52 }} />
			</div>
			<div style={{ display: "flex", height }}>
				<div style={{ width: 50, borderRight: "1px solid var(--border)", background: "var(--surface-sunken)", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "14px 0", flexShrink: 0 }}>
					<span style={{ color: "var(--text-primary)", marginBottom: 8 }}><Mark size={18} /></span>
					{SLIM_NAV.map((k, i) => (
						<span key={i} style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: "var(--radius-sm)", color: i === 0 ? "var(--text-primary)" : "var(--text-disabled)", background: i === 0 ? "var(--surface-muted)" : "transparent" }}>
							<Icon k={k} size={16} />
						</span>
					))}
				</div>
				<div style={{ flex: 1, padding: 22, minWidth: 0, overflow: "hidden" }}>{children}</div>
			</div>
		</div>
	);
}

/** Four overview metric tiles for the console mock. */
function StatTiles() {
	const tiles: [IconKey, string, string][] = [
		["layers", "6", "Specs"],
		["grid", "4", "Clusters"],
		["server", "11/12", "Runners online"],
		["jobs", "38", "Jobs today"],
	];
	return (
		<div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 18 }}>
			{tiles.map(([ic, v, l]) => (
				<div key={l} style={{ display: "flex", alignItems: "center", gap: 11, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "11px 13px", background: "var(--surface)" }}>
					<span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: "var(--radius-sm)", background: "var(--surface-muted)", color: "var(--text-secondary)" }}><Icon k={ic} size={15} /></span>
					<div>
						<div style={{ ...disp, fontSize: 18, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--text-primary)", lineHeight: 1 }}>{v}</div>
						<div style={{ fontSize: 10.5, color: "var(--text-tertiary)", marginTop: 3 }}>{l}</div>
					</div>
				</div>
			))}
		</div>
	);
}

/** Mock console page header (eyebrow + title + action). */
function PageMini({ eb, title, action, children }: { eb: string; title: string; action?: ReactNode; children: ReactNode }) {
	return (
		<div>
			<div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 16 }}>
				<div>
					<div style={{ ...eyebrow, fontSize: 9, marginBottom: 5 }}>{eb}</div>
					<div style={{ ...disp, fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", color: "var(--text-primary)" }}>{title}</div>
				</div>
				{action}
			</div>
			{children}
		</div>
	);
}

const SWITCHER_TABS: [string, IconKey, string][] = [
	["console", "grid", "Console"],
	["agent", "sparkles", "Agent"],
	["runners", "server", "Runners"],
	["jobs", "jobs", "Jobs"],
	["cli", "terminal", "CLI"],
];

/** Hero centerpiece — tabbed preview of Console / Agent / Runners / Jobs / CLI. */
function ProductSwitcher() {
	const [tab, setTab] = useState("console");
	return (
		<div style={{ width: "100%", maxWidth: 880 }}>
			<div style={{ display: "inline-flex", gap: 3, padding: 4, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--surface)", marginBottom: 18 }}>
				{SWITCHER_TABS.map(([id, ic, label]) => (
					<button
						key={id}
						type="button"
						onClick={() => setTab(id)}
						style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderRadius: "var(--radius-sm)", border: "none", cursor: "pointer", fontSize: 13, fontFamily: "inherit", fontWeight: 500, color: tab === id ? "var(--text-primary)" : "var(--text-tertiary)", background: tab === id ? "var(--surface-muted)" : "transparent", transition: "color .12s, background .12s" }}
					>
						<Icon k={ic} size={15} />{label}
					</button>
				))}
			</div>
			{tab === "cli" ? (
				<LiveTerminal height={440} />
			) : (
				<BrowserFrame url={"console.alethialabs.io/" + (tab === "console" ? "overview" : tab)}>
					{tab === "console" && (
						<PageMini eb="Acme Cloud · production" title="Overview" action={<Button size="sm"><Icon k="layers" size={14} />Create a Spec</Button>}>
							<StatTiles />
							<div style={{ ...eyebrow, fontSize: 9, margin: "4px 0 10px" }}>Recent jobs</div>
							<JobsTable rows={JOBS.slice(0, 3)} compact />
						</PageMini>
					)}
					{tab === "agent" && (
						<PageMini eb="Assistant" title="Agent" action={<Pill>ask · act</Pill>}>
							<AgentThread compact />
						</PageMini>
					)}
					{tab === "runners" && (
						<PageMini eb="Operate" title="Runners" action={<Pill>3 pools · 11 online</Pill>}>
							<p style={{ fontSize: 12.5, color: "var(--text-tertiary)", margin: "0 0 14px", lineHeight: 1.5 }}>Warm pools the controller keeps sized to demand. Status reads through shape and weight, never color.</p>
							<PoolList />
						</PageMini>
					)}
					{tab === "jobs" && (
						<PageMini eb="Operate" title="Jobs" action={<Pill>live</Pill>}>
							<JobsTable rows={JOBS} />
						</PageMini>
					)}
				</BrowserFrame>
			)}
		</div>
	);
}

/** Landing hero — grid backdrop, headline, dual CTAs, and the product switcher. */
export function Hero() {
	return (
		<section style={{ position: "relative", paddingTop: 78, paddingBottom: 60, overflow: "hidden" }}>
			<div className="ah-grid-bg" />
			<Wrap style={{ position: "relative", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center" }}>
				<HeroRail kicker="alethia · control plane" status="all systems live" maxWidth={600} />
				<h1 className="ah-h1" style={{ ...disp, fontSize: 64, fontWeight: 600, letterSpacing: "-0.045em", lineHeight: 1.03, margin: 0, maxWidth: 880, color: "var(--text-primary)" }}>
					One control plane for<br />
					<span style={{ color: "var(--text-tertiary)" }}>multi-cloud infrastructure.</span>
				</h1>
				<p style={{ fontSize: 18.5, color: "var(--text-secondary)", maxWidth: 640, margin: "24px 0 32px", lineHeight: 1.55 }}>
					Design infrastructure as a Spec, deploy it across AWS, GCP, and Azure with zero stored credentials, and operate everything — jobs, runners, alerts, and an AI agent — from the console or the <code style={{ ...mono, fontSize: 16, color: "var(--text-primary)" }}>alethia</code> CLI.
				</p>
				<div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 50, flexWrap: "wrap", justifyContent: "center" }}>
					<Button size="lg">Get started <Icon k="arrow" size={15} /></Button>
					<Button size="lg" variant="outline"><Icon k="book" size={15} />Read the docs</Button>
				</div>
				<ProductSwitcher />
			</Wrap>
		</section>
	);
}
