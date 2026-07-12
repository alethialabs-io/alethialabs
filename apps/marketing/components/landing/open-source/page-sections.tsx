// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties } from "react";
import Link from "next/link";
import { disp, eyebrow, HeroRail, Icon, type IconKey, mono, SecMark, Wrap } from "../home/primitives";

/* ---------- small local helpers (site idiom: hairline surfaces, mono data) ---------- */

/** Compact star count (2400 ÃÂ¢ÃÂÃÂ "2.4k"); "" when unknown. */
function fmtStars(n: number | null | undefined): string {
	if (n == null) return "";
	if (n < 1000) return ` ÃÂÃÂ· ${n}`;
	const k = n / 1000;
	return ` ÃÂÃÂ· ${(k >= 10 ? Math.round(k) : Math.round(k * 10) / 10)}k`;
}

/** Filled-ink primary / hairline secondary link button, matching the site's controls. */
function CTA({ href, children, primary, external }: { href: string; children: React.ReactNode; primary?: boolean; external?: boolean }) {
	const base: CSSProperties = {
		display: "inline-flex", alignItems: "center", gap: 8, height: 38, padding: "0 16px",
		fontSize: 14, fontWeight: 500, borderRadius: "var(--radius-sm)", textDecoration: "none",
	};
	const style: CSSProperties = primary
		? { ...base, background: "var(--ink)", color: "var(--ink-foreground)" }
		: { ...base, border: "1px solid var(--border-strong)", color: "var(--text-primary)" };
	return external ? (
		<a href={href} target="_blank" rel="noreferrer" style={style}>{children}</a>
	) : (
		<Link href={href} style={style}>{children}</Link>
	);
}

/** A bordered command line, mono. */
function Command({ children }: { children: React.ReactNode }) {
	return (
		<div style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--surface-sunken)", padding: "12px 14px", maxWidth: 560 }}>
			<span style={{ ...mono, fontSize: 12, color: "var(--text-disabled)" }}>$</span>
			<code style={{ ...mono, fontSize: 12.5, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{children}</code>
		</div>
	);
}

/* ---------- 00 ÃÂÃÂ· Hero ---------- */

function Hero({ stars }: { stars: number | null }) {
	return (
		<section style={{ padding: "96px 0 76px", borderBottom: "1px solid var(--border)" }}>
			<Wrap>
				<HeroRail kicker="Open source" status="AGPL-3.0" />
				<h1 style={{ ...disp, fontSize: 52, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1.04, margin: "0 0 20px", color: "var(--text-primary)", maxWidth: 760 }}>
					Run the entire control plane yourself.
				</h1>
				<p style={{ fontSize: 16.5, color: "var(--text-tertiary)", lineHeight: 1.6, margin: "0 0 30px", maxWidth: 600 }}>
					Alethia is open source under the GNU AGPL. Self-host the whole platform ÃÂ¢ÃÂÃÂ console, CLI,
					runners, multi-cloud provisioning ÃÂ¢ÃÂÃÂ on your own infrastructure, on any cloud. We host
					nothing: the clusters are yours, and so is the control plane.
				</p>
				<div style={{ marginBottom: 26 }}>
					<Command>curl -fsSL https://raw.githubusercontent.com/alethialabs-io/alethialabs/main/deploy/install.sh | sh</Command>
				</div>
				<div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
					<CTA href="/docs/self-hosting" primary><Icon k="book" size={15} /> Read the self-host docs</CTA>
					<CTA href="https://github.com/alethialabs-io/alethialabs" external><Icon k="git" size={15} /> Star on GitHub{fmtStars(stars)}</CTA>
				</div>
			</Wrap>
		</section>
	);
}

/* ---------- 01 ÃÂÃÂ· Portable, closed-origin (the differentiator) ---------- */

const CLOUDS: { name: string; access: string; hardening: string }[] = [
	{ name: "Hetzner", access: "SSH (key-only)", hardening: "firewall: SSH only" },
	{ name: "GCP", access: "IAP tunnel", hardening: "Shielded VM" },
	{ name: "AWS", access: "SSM Session Manager", hardening: "IMDSv2 ÃÂÃÂ· encrypted EBS" },
	{ name: "Azure", access: "az vm run-command", hardening: "Trusted Launch" },
	{ name: "Alibaba", access: "Session Manager", hardening: "encrypted disk" },
];

function Proof() {
	return (
		<section style={{ padding: "84px 0", borderBottom: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<SecMark n="01" label="Portable ÃÂÃÂ· closed-origin" />
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1.15fr", gap: 56, alignItems: "start" }} className="ah-surface">
					<div>
						<h2 style={{ ...disp, fontSize: 34, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 14px", color: "var(--text-primary)" }}>
							One control plane, five clouds, zero open ports.
						</h2>
						<p style={{ fontSize: 15, color: "var(--text-tertiary)", lineHeight: 1.65, margin: "0 0 22px", maxWidth: 440 }}>
							Each per-cloud stack fronts the box with a Cloudflare Tunnel ÃÂ¢ÃÂÃÂ the origin dials out,
							so no web port is ever exposed. Admin access is the cloudÃ¢ÂÂs own no-open-port channel,
							never a public SSH port. Pick a cloud; the OpenTofu is version-controlled and CI-checked.
						</p>
						<Link href="/docs/self-hosting/terraform" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--text-primary)", borderBottom: "1px solid var(--border-strong)", paddingBottom: 3, textDecoration: "none" }}>
							Per-cloud deploy guide <Icon k="arrow" size={14} />
						</Link>
					</div>
					<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", boxShadow: "var(--shadow-sm)", overflow: "hidden" }}>
						<div style={{ display: "grid", gridTemplateColumns: "0.8fr 1.1fr 1.1fr", padding: "9px 16px", borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
							{["Cloud", "Admin access", "Hardening"].map((c) => <span key={c} style={{ ...eyebrow, fontSize: 9 }}>{c}</span>)}
						</div>
						{CLOUDS.map((c, i) => (
							<div key={c.name} style={{ display: "grid", gridTemplateColumns: "0.8fr 1.1fr 1.1fr", alignItems: "center", padding: "13px 16px", borderBottom: i < CLOUDS.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
								<span style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{c.name}</span>
								<span style={{ ...mono, fontSize: 11.5, color: "var(--text-secondary)" }}>{c.access}</span>
								<span style={{ ...mono, fontSize: 11, color: "var(--text-tertiary)" }}>{c.hardening}</span>
							</div>
						))}
					</div>
				</div>
			</Wrap>
		</section>
	);
}

/* ---------- 02 ÃÂÃÂ· What's open (editions / trust) ---------- */

function Editions() {
	const card: CSSProperties = { border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", padding: "26px", boxShadow: "var(--shadow-sm)" };
	return (
		<section style={{ padding: "84px 0", borderBottom: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="02" label="What's open" />
				<h2 style={{ ...disp, fontSize: 34, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 30px", color: "var(--text-primary)", maxWidth: 620 }}>
					Genuinely open source. One honest paid boundary.
				</h2>
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }} className="ah-surface">
					<div style={card}>
						<span style={{ ...mono, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>Core ÃÂÃÂ· AGPL-3.0</span>
						<h3 style={{ ...disp, fontSize: 19, fontWeight: 600, margin: "10px 0 10px", color: "var(--text-primary)" }}>The whole platform, free.</h3>
						<p style={{ fontSize: 14, color: "var(--text-tertiary)", lineHeight: 1.6, margin: 0 }}>
							Console, the <code style={{ ...mono, fontSize: 12.5 }}>alethia</code> CLI, self-healing
							runners, multi-cloud provisioning, GitOps reconciliation. AGPL is OSI-approved open
							source ÃÂ¢ÃÂÃÂ not source-available. Self-host it anywhere, forever.
						</p>
					</div>
					<div style={card}>
						<span style={{ ...mono, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-tertiary)" }}>Enterprise ÃÂÃÂ· ee/</span>
						<h3 style={{ ...disp, fontSize: 19, fontWeight: 600, margin: "10px 0 10px", color: "var(--text-primary)" }}>One directory, one license.</h3>
						<p style={{ fontSize: 14, color: "var(--text-tertiary)", lineHeight: 1.6, margin: 0 }}>
							SSO, custom RBAC, the audit trail, and managed runners live under <code style={{ ...mono, fontSize: 12.5 }}>ee/</code> ÃÂ¢ÃÂÃÂ
							the only commercially-licensed code, and the boundary is enforced in CI so it can
							never blur into the core.
						</p>
					</div>
				</div>
				<div style={{ display: "flex", gap: 20, marginTop: 22 }}>
					<Link href="/docs/editions" style={{ ...linkStyle }}>Editions <Icon k="arrow" size={13} /></Link>
					<Link href="/docs/editions/licensing" style={{ ...linkStyle }}>Licensing <Icon k="arrow" size={13} /></Link>
				</div>
			</Wrap>
		</section>
	);
}

const linkStyle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, color: "var(--text-secondary)", textDecoration: "none", borderBottom: "1px solid var(--border-strong)", paddingBottom: 2 };

/* ---------- 03 ÃÂÃÂ· Self-host, honestly (candor) ---------- */

function Ops() {
	const YOU = ["Security patches & CVEs", "Uptime & capacity", "Upgrades & migrations", "Backups & restore"];
	const US = ["Zero-downtime upgrades", "Warm-pool scaling", "SLA & on-call", "Backups managed for you"];
	const col = (title: string, items: string[], muted?: boolean): React.ReactNode => (
		<div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: muted ? "var(--surface-sunken)" : "var(--surface)", padding: "22px 24px" }}>
			<span style={{ ...eyebrow, fontSize: 10 }}>{title}</span>
			<div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
				{items.map((it) => (
					<div key={it} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13.5, color: "var(--text-secondary)" }}>
						<Icon k="check" size={13} sw={2} /> {it}
					</div>
				))}
			</div>
		</div>
	);
	return (
		<section style={{ padding: "84px 0", borderBottom: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<SecMark n="03" label="Self-host, honestly" />
				<h2 style={{ ...disp, fontSize: 34, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 14px", color: "var(--text-primary)", maxWidth: 620 }}>
					Full control means you carry the operations.
				</h2>
				<p style={{ fontSize: 15, color: "var(--text-tertiary)", lineHeight: 1.65, margin: "0 0 30px", maxWidth: 560 }}>
					Thatâs the honest trade. Self-hosting gives you data residency and zero lock-in; the day-2
					work that managed Alethia does for its customers becomes yours. If you’d rather not carry it,
					we run it.
				</p>
				<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }} className="ah-surface">
					{col("You run it", YOU)}
					{col("We run it", US, true)}
				</div>
				<div style={{ display: "flex", gap: 12, marginTop: 24 }}>
					<CTA href="/pricing">See managed pricing</CTA>
					<CTA href="/enterprise">Enterprise</CTA>
				</div>
			</Wrap>
		</section>
	);
}

/* ---------- 04 ÃÂÃÂ· Ways to run it ---------- */

const PATHS: { ic: IconKey; name: string; body: string; href: string }[] = [
	{ ic: "terminal", name: "Docker Compose", body: "One command on a fresh VM. The whole bundle behind Caddy.", href: "/docs/self-hosting" },
	{ ic: "layers", name: "Terraform (per-cloud)", body: "Version-controlled OpenTofu, closed-origin behind a tunnel.", href: "/docs/self-hosting/terraform" },
	{ ic: "node", name: "Helm", body: "The same bundle on an existing Kubernetes cluster.", href: "/docs/self-hosting/helm" },
	{ ic: "zap", name: "One-click", body: "Launch on AWS or Azure from a prefilled template.", href: "/docs/self-hosting/one-click" },
];

function DeployPaths() {
	return (
		<section style={{ padding: "84px 0", borderBottom: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="04" label="Ways to run it" />
				<div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 16 }} className="ah-surface">
					{PATHS.map((p) => (
						<Link key={p.name} href={p.href} style={{ display: "flex", gap: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", padding: "20px 22px", textDecoration: "none" }} className="ah-card">
							<span style={{ display: "grid", placeItems: "center", width: 34, height: 34, flexShrink: 0, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface-sunken)", color: "var(--text-primary)" }}>
								<Icon k={p.ic} size={17} />
							</span>
							<div>
								<div style={{ ...disp, fontSize: 15, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}>{p.name} <Icon k="arrow" size={13} /></div>
								<p style={{ fontSize: 13, color: "var(--text-tertiary)", margin: 0, lineHeight: 1.55 }}>{p.body}</p>
							</div>
						</Link>
					))}
				</div>
			</Wrap>
		</section>
	);
}

/* ---------- 05 ÃÂÃÂ· Closing CTA ---------- */

function Close({ stars }: { stars: number | null }) {
	return (
		<section style={{ padding: "92px 0" }}>
			<Wrap style={{ textAlign: "center" }}>
				<h2 style={{ ...disp, fontSize: 40, fontWeight: 600, letterSpacing: "-0.04em", margin: "0 0 16px", color: "var(--text-primary)" }}>Yours to run.</h2>
				<p style={{ fontSize: 15.5, color: "var(--text-tertiary)", lineHeight: 1.6, margin: "0 auto 28px", maxWidth: 440 }}>
					Clone it, read the source, deploy it on your own cloud. Open the docs or star the repo.
				</p>
				<div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
					<CTA href="/docs/self-hosting" primary><Icon k="book" size={15} /> Self-host docs</CTA>
					<CTA href="https://github.com/alethialabs-io/alethialabs" external><Icon k="git" size={15} /> Star on GitHub{fmtStars(stars)}</CTA>
				</div>
			</Wrap>
		</section>
	);
}

/** All sections of the /open-source page, in order. */
export function OpenSourceSections({ stars }: { stars: number | null }) {
	return (
		<>
			<Hero stars={stars} />
			<Proof />
			<Editions />
			<Ops />
			<DeployPaths />
			<Close stars={stars} />
		</>
	);
}
