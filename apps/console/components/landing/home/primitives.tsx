// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties, ReactNode } from "react";
import Image from "next/image";
import {
	ArrowRight,
	Bell,
	BookOpen,
	Building2,
	Check,
	ChevronDown,
	ClipboardCheck,
	ClipboardList,
	Copy,
	Gauge,
	GitBranch,
	KeyRound,
	Layers,
	LayoutGrid,
	List,
	Lock,
	PenLine,
	Plug,
	Route,
	ScanLine,
	Server,
	Shield,
	SlidersHorizontal,
	Sparkles,
	Terminal,
	Users,
	Workflow,
	Zap,
} from "lucide-react";
import { ProviderIcon } from "@/components/provider-icon";
import { StatusBadge } from "@/components/ui/status-badge";

/* ---------- shared inline-style tokens (mirror the design's helpers) ---------- */
export const mono: CSSProperties = { fontFamily: "var(--font-mono)" };
export const disp: CSSProperties = { fontFamily: "var(--font-display)" };
export const eyebrow: CSSProperties = {
	fontFamily: "var(--font-mono)",
	fontSize: 11,
	letterSpacing: "0.18em",
	textTransform: "uppercase",
	color: "var(--text-tertiary)",
	margin: 0,
};

/** Centered max-width content wrapper used by every section. */
export function Wrap({
	children,
	style,
}: {
	children: ReactNode;
	style?: CSSProperties;
}) {
	return (
		<div style={{ maxWidth: 1160, margin: "0 auto", padding: "0 32px", ...style }}>
			{children}
		</div>
	);
}

/* ---------- brand mark ---------- */
/** The bracketed-point [·] mark, drawn in currentColor. */
export function Mark({ size = 26 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ display: "block" }}>
			<path d="M11 6 H6.5 V26 H11" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M21 6 H25.5 V26 H21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
			<circle cx="16" cy="16" r="2.9" fill="currentColor" />
		</svg>
	);
}

/**
 * HeroRail — the "system online" status line that replaces the centered hero badge.
 * Fading hairlines frame the [·] mark + a mono kicker + a live pulse + status.
 */
export function HeroRail({
	kicker,
	status = "operational",
	maxWidth = 620,
}: {
	kicker: string;
	status?: string;
	maxWidth?: number;
}) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 20, width: "100%", maxWidth, marginBottom: 32 }}>
			<span style={{ flex: 1, height: 1, minWidth: 24, background: "linear-gradient(90deg, transparent, var(--border-strong))" }} />
			<span style={{ display: "inline-flex", alignItems: "center", gap: 11, whiteSpace: "nowrap" }}>
				<span style={{ color: "var(--text-secondary)", display: "flex" }}><Mark size={16} /></span>
				<span style={{ ...mono, fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--text-secondary)" }}>{kicker}</span>
				<span style={{ width: 3, height: 3, borderRadius: 999, background: "var(--text-disabled)" }} />
				<span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
					<span className="ah-pulse" />
					<span style={{ ...mono, fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>{status}</span>
				</span>
			</span>
			<span style={{ flex: 1, height: 1, minWidth: 24, background: "linear-gradient(90deg, var(--border-strong), transparent)" }} />
		</div>
	);
}

/** [·] Alethia · LABS company lockup. */
export function Lockup({ size = 24 }: { size?: number }) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 11, color: "var(--text-primary)" }}>
			<Mark size={size} />
			<span style={{ ...disp, fontSize: size * 0.75, fontWeight: 600, letterSpacing: "-0.01em" }}>
				Alethia
			</span>
			<span style={{ ...mono, fontSize: 9, letterSpacing: "0.26em", textTransform: "uppercase", color: "var(--text-tertiary)", opacity: 0.8 }}>
				Labs
			</span>
		</div>
	);
}

/* ---------- icon registry → lucide (keyed like the design's icon set) ---------- */
const ICONS = {
	arrow: ArrowRight,
	chev: ChevronDown,
	check: Check,
	copy: Copy,
	terminal: Terminal,
	grid: LayoutGrid,
	server: Server,
	jobs: ClipboardCheck,
	bell: Bell,
	shield: Shield,
	lock: Lock,
	layers: Layers,
	git: GitBranch,
	book: BookOpen,
	route: Route,
	list: List,
	pen: PenLine,
	gauge: Gauge,
	zap: Zap,
	sparkles: Sparkles,
	scan: ScanLine,
	plug: Plug,
	building: Building2,
	key: KeyRound,
	audit: ClipboardList,
	sliders: SlidersHorizontal,
	node: Workflow,
	users: Users,
} as const;

export type IconKey = keyof typeof ICONS;

/** Renders a lucide icon by the design's key name. */
export function Icon({
	k,
	size = 18,
	sw = 1.7,
}: {
	k: IconKey;
	size?: number;
	sw?: number;
}) {
	const C = ICONS[k];
	return <C size={size} strokeWidth={sw} />;
}

/* ---------- provider / integration logos ---------- */
export type ProviderId = "aws" | "gcp" | "azure";

/** Grayscale cloud-provider logo. */
export function Prov({ id, size = 14 }: { id: ProviderId; size?: number }) {
	return <ProviderIcon provider={id} size={size} className="grayscale opacity-90" />;
}

export type IntegrationId =
	| "github"
	| "gitlab"
	| "bitbucket"
	| "cloudflare"
	| "datadog"
	| "grafana"
	| "prometheus"
	| "dockerhub";

/** Grayscale third-party integration logo from /public/icons. */
export function IntegrationLogo({
	id,
	size = 19,
	className,
}: {
	id: IntegrationId;
	size?: number;
	className?: string;
}) {
	return (
		<Image
			src={`/icons/${id}/${id}-32x32.png`}
			alt={id}
			title={id}
			width={size}
			height={size}
			className={className}
			style={{ objectFit: "contain" }}
		/>
	);
}

/* ---------- section marker ("01 — Label") ---------- */
/** Numbered eyebrow marker that opens each content section. */
export function SecMark({ n, label }: { n: string; label: string }) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
			<span style={{ ...mono, fontSize: 11, color: "var(--text-disabled)", letterSpacing: "0.1em" }}>{n}</span>
			<span style={{ width: 22, height: 1, background: "var(--border-strong)" }} />
			<span style={{ ...eyebrow }}>{label}</span>
		</div>
	);
}

/* ---------- jobs table (console mock + specs→jobs) ---------- */
export interface JobRow {
	type: string;
	status: string;
	spec: string;
	provider: ProviderId | null;
	runner: string;
	created: string;
	duration: string;
}

export const JOBS: JobRow[] = [
	{ type: "Apply", status: "active", spec: "api-backend", provider: "aws", runner: "prod-eu-1", created: "2m ago", duration: "12m 34s" },
	{ type: "Plan", status: "active", spec: "web-frontend", provider: "gcp", runner: "prod-eu-1", created: "18m ago", duration: "1m 12s" },
	{ type: "Apply", status: "processing", spec: "data-pipeline", provider: "azure", runner: "eu-2", created: "24m ago", duration: "4m 02s" },
	{ type: "Destroy", status: "failed", spec: "legacy-api", provider: "aws", runner: "prod-eu-1", created: "1h ago", duration: "3m 41s" },
	{ type: "Fetch resources", status: "queued", spec: "—", provider: null, runner: "—", created: "1h ago", duration: "—" },
];

/** Provisioning-jobs table — Type / Status / Spec / Runner / Created / Duration. */
export function JobsTable({ rows, compact }: { rows: JobRow[]; compact?: boolean }) {
	const cols = ["Type", "Status", "Spec", "Runner", "Created", "Duration"];
	const grid = "1.3fr 1.05fr 1.25fr 1fr 0.9fr 0.85fr";
	return (
		<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--surface)" }}>
			<div style={{ display: "grid", gridTemplateColumns: grid, padding: "9px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
				{cols.map((c) => (
					<span key={c} style={{ ...eyebrow, fontSize: 9 }}>{c}</span>
				))}
			</div>
			{rows.map((r, i) => (
				<div key={i} style={{ display: "grid", gridTemplateColumns: grid, alignItems: "center", padding: compact ? "10px 16px" : "12px 16px", borderBottom: i < rows.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
					<span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text-primary)" }}>{r.type}</span>
					<span><StatusBadge status={r.status} /></span>
					<span style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--text-secondary)", ...mono }}>
						{r.provider ? <Prov id={r.provider} size={13} /> : <span style={{ width: 13 }} />}
						{r.spec}
					</span>
					<span style={{ fontSize: 11.5, color: "var(--text-secondary)", ...mono }}>{r.runner}</span>
					<span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{r.created}</span>
					<span style={{ fontSize: 11.5, color: "var(--text-tertiary)", ...mono }}>{r.duration}</span>
				</div>
			))}
		</div>
	);
}

/* ---------- runner pools (fleet + console runners tab) ---------- */
interface Pool {
	prov: string;
	on: number;
	tgt: number;
	rollout?: string;
}

const POOLS: Pool[] = [
	{ prov: "AWS", on: 5, tgt: 6, rollout: "80%" },
	{ prov: "GCP", on: 4, tgt: 4 },
	{ prov: "Azure", on: 2, tgt: 2 },
];

/** Per-cloud warm-pool list with bordered capacity cells. */
export function PoolList() {
	return (
		<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--surface)" }}>
			{POOLS.map((p, i) => (
				<div key={p.prov} style={{ display: "flex", alignItems: "center", gap: 14, padding: "16px", borderBottom: i < POOLS.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
					<span style={{ width: 44, ...mono, fontSize: 11, color: "var(--text-secondary)", letterSpacing: "0.04em" }}>{p.prov}</span>
					<div style={{ display: "flex", gap: 3 }}>
						{Array.from({ length: p.tgt }).map((_, k) => (
							<span key={k} style={{ width: 16, height: 9, border: "1px solid " + (k < p.on ? "var(--text-primary)" : "var(--border-strong)"), background: k < p.on ? "var(--text-primary)" : "transparent" }} />
						))}
					</div>
					<span style={{ ...mono, fontSize: 11, color: "var(--text-tertiary)" }}>{p.on}/{p.tgt}</span>
					<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9 }}>
						<span style={{ ...mono, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: p.rollout ? "var(--text-primary)" : "var(--text-tertiary)" }}>
							{p.rollout ? "rollout " + p.rollout : "steady"}
						</span>
						<span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--text-primary)", boxShadow: p.rollout ? "inset 0 0 0 2.5px var(--surface)" : "none" }} />
					</span>
				</div>
			))}
		</div>
	);
}

/* ---------- agent primitives (hero switcher + AI section) ---------- */
/** Completed tool-call chip (e.g. scan_repo(orders-api) · done). */
export function ToolChip({ name, arg }: { name: string; arg: string }) {
	return (
		<div style={{ display: "inline-flex", alignItems: "center", gap: 8, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "5px 9px", background: "var(--surface-sunken)" }}>
			<Icon k="check" size={12} sw={2} />
			<code style={{ ...mono, fontSize: 11, color: "var(--text-primary)" }}>
				{name}<span style={{ color: "var(--text-tertiary)" }}>({arg})</span>
			</code>
			<span style={{ ...mono, fontSize: 8.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>done</span>
		</div>
	);
}

/** Chat bubble for the agent thread (you / agent). */
export function Msg({ role, children }: { role: "you" | "agent"; children: ReactNode }) {
	const you = role === "you";
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: you ? "flex-end" : "flex-start" }}>
			<span style={{ ...eyebrow, fontSize: 8 }}>{you ? "You" : "Agent"}</span>
			<div style={{ maxWidth: "86%", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "9px 12px", background: you ? "var(--surface-muted)" : "var(--surface)", fontSize: 12.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>
				{children}
			</div>
		</div>
	);
}

/** Agent "proposed operation" card requiring approval. */
export function ProposeCard({
	op = "plan_spec",
	spec = "orders-api",
	add = 23,
	cost = "$312/mo",
}: {
	op?: string;
	spec?: string;
	add?: number;
	cost?: string;
}) {
	return (
		<div style={{ border: "1px solid var(--border-strong)", borderRadius: "var(--radius-md)", background: "var(--surface)", overflow: "hidden", width: "100%" }}>
			<div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", borderBottom: "1px solid var(--border-faint)" }}>
				<Icon k="layers" size={14} />
				<span style={{ ...disp, fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)" }}>Proposed operation</span>
				<span style={{ ...mono, fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-tertiary)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-xs)", padding: "2px 6px", marginLeft: "auto" }}>needs approval</span>
			</div>
			<div style={{ padding: "11px 12px" }}>
				<code style={{ ...mono, fontSize: 12, color: "var(--text-primary)" }}>{op} · {spec}</code>
				<div style={{ display: "flex", gap: 13, margin: "9px 0 12px", ...mono, fontSize: 10.5, color: "var(--text-tertiary)" }}>
					<span>{add} to add</span><span>0 change</span><span>0 destroy</span>
					<span style={{ color: "var(--text-secondary)", marginLeft: "auto" }}>~{cost}</span>
				</div>
				<div style={{ display: "flex", gap: 8 }}>
					<span style={{ display: "inline-flex", alignItems: "center", height: 28, padding: "0 12px", fontSize: 12, fontWeight: 500, background: "var(--ink)", color: "var(--ink-foreground)" }}>Approve</span>
					<span style={{ display: "inline-flex", alignItems: "center", height: 28, padding: "0 12px", fontSize: 12, fontWeight: 500, border: "1px solid var(--border-strong)", color: "var(--text-secondary)" }}>Reject</span>
				</div>
			</div>
		</div>
	);
}

/** Agent conversation: scan a repo → propose a stack. */
export function AgentThread({ compact }: { compact?: boolean }) {
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: compact ? 11 : 13 }}>
			<Msg role="you">
				Scan <code style={{ ...mono, fontSize: 11.5, color: "var(--text-primary)" }}>github.com/acme/orders-api</code> and propose a stack on AWS.
			</Msg>
			<div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
				<span style={{ ...eyebrow, fontSize: 8 }}>Agent</span>
				<ToolChip name="scan_repo" arg="orders-api" />
			</div>
			{!compact && (
				<Msg role="agent">
					Go service · Postgres · Redis. Proposed <b style={{ color: "var(--text-primary)", fontWeight: 600 }}>orders-api</b>: EKS · Aurora Postgres · ElastiCache.
				</Msg>
			)}
			{!compact && <Msg role="you">Looks right — show me the plan.</Msg>}
			<ProposeCard />
		</div>
	);
}

/* ---------- AI ask/act row ---------- */
/** Icon + title + body row used in the AI ask/act panel. */
export function AskActRow({ ic, title, body }: { ic: IconKey; title: string; body: string }) {
	return (
		<div style={{ display: "flex", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--border-faint)" }}>
			<span style={{ display: "grid", placeItems: "center", width: 32, height: 32, flexShrink: 0, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface-sunken)", color: "var(--text-primary)" }}>
				<Icon k={ic} size={16} />
			</span>
			<div>
				<div style={{ ...disp, fontSize: 13.5, fontWeight: 600, color: "var(--text-primary)", marginBottom: 3 }}>{title}</div>
				<p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: 0, lineHeight: 1.5 }}>{body}</p>
			</div>
		</div>
	);
}
