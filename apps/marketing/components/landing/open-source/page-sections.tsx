// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties } from "react";
import Link from "next/link";
import { Button } from "@repo/ui/button";
import { cloudListLabel } from "@repo/cloud-catalog";
import { CommandBlock } from "@repo/brand/site-command-block";
import { disp, Icon, type IconKey, mono, SecMark, Wrap } from "@repo/brand/site-primitives";
import { formatStars, PageHero } from "@repo/brand/site-sections";

/**
 * The /open-source page.
 *
 * `app/open-source/page.tsx` wraps this in `<Reveal>`, which selects
 * `:scope > section` and skips the first — so every component below renders a
 * `<section>` as its outermost element and `OpenSourceSections` returns them as
 * a flat fragment. A wrapper div here silently kills every scroll animation.
 */

const REPO_URL = "https://github.com/alethialabs-io/alethialabs";

/** The self-host installer, as `deploy/install.sh` on the main branch serves it. */
const INSTALL_COMMAND =
	"curl -fsSL https://raw.githubusercontent.com/alethialabs-io/alethialabs/main/deploy/install.sh | sh";

/** Below this many stars the count reads as an admission, not as proof, so it is not shown. */
const STAR_COUNT_FLOOR = 100;

/** "Star on GitHub · 2.4k", or just "Star on GitHub" when the count is unknown or still small. */
function starLabel(stars: number | null): string {
	if (stars === null || stars < STAR_COUNT_FLOOR) return "Star on GitHub";
	const count = formatStars(stars);
	return count ? `Star on GitHub · ${count}` : "Star on GitHub";
}

/* ---------- Hero ---------- */

/**
 * The opening, through the shared `PageHero` so the headline takes `ah-h1` and
 * shrinks on a phone — the inline `fontSize: 52` it used to carry did not.
 */
function Hero({ stars }: { stars: number | null }) {
	return (
		<PageHero
			kicker="Open source"
			status="AGPL-3.0"
			align="left"
			headline={{ lead: "Run the entire control plane yourself." }}
			lede={`Self-host the console, the CLI, the runner and provisioning on ${cloudListLabel()}.`}
			ctas={[
				{ label: "Self-host docs", href: "/docs/guides/self-hosting", icon: "book", iconBefore: true },
				{ label: starLabel(stars), href: REPO_URL, variant: "outline", icon: "git", iconBefore: true, external: true },
			]}
			artifact={
				<div className="max-w-[640px]">
					<CommandBlock label="Install" command={INSTALL_COMMAND} />
				</div>
			}
		/>
	);
}

/* ---------- 01 · Portable, closed-origin ---------- */

/**
 * Admin access and hardening per per-cloud Terraform stack. Hetzner's row is why
 * the copy above it says "no open WEB ports": its admin channel is key-only SSH
 * behind a firewall, so the old "zero open ports … never a public SSH port" was
 * contradicted by one row of this very table.
 */
const CLOUDS: { name: string; access: string; hardening: string }[] = [
	{ name: "Hetzner", access: "SSH (key-only)", hardening: "firewall: SSH only" },
	{ name: "GCP", access: "IAP tunnel", hardening: "Shielded VM" },
	{ name: "AWS", access: "SSM Session Manager", hardening: "IMDSv2 · encrypted EBS" },
	{ name: "Azure", access: "az vm run-command", hardening: "Trusted Launch" },
];

/** The closed-origin proof: one sentence, the per-cloud table, the guide link. */
function Proof() {
	return (
		<section className="py-[84px] max-[640px]:py-[64px]" style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<SecMark n="01" label="Portable · closed-origin" />
				<div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[1fr_1.15fr] lg:gap-14">
					<div>
						<h2 className="text-[34px] max-[640px]:text-[28px]" style={{ ...disp, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 14px", color: "var(--text-primary)" }}>
							One control plane, four clouds, no open web ports.
						</h2>
						{/* Scoped to the Terraform stacks on purpose: the one-click templates
						    open 22/80/443 (docs/guides/self-hosting/one-click). */}
						<p className="m-0 mb-5 max-w-[440px] text-[15px] leading-[1.65] text-text-tertiary">
							Each per-cloud stack sits behind a Cloudflare Tunnel; admin access uses the
							cloud&rsquo;s own channel (key-only SSH on Hetzner).
						</p>
						<Link href="/docs/guides/self-hosting/terraform" style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 14, color: "var(--text-primary)", borderBottom: "1px solid var(--border-strong)", paddingBottom: 3, textDecoration: "none" }}>
							Per-cloud deploy guide <Icon k="arrow" size={14} />
						</Link>
					</div>
					{/* A real table that scrolls inside its own box below its min width,
					    so the page itself never scrolls sideways on a phone. */}
					<div className="overflow-x-auto" style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", boxShadow: "var(--shadow-sm)" }}>
						<table className="w-full min-w-[420px] border-collapse text-left">
							<caption className="sr-only">Self-host stacks — admin access and hardening per cloud</caption>
							<thead>
								<tr style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-muted)" }}>
									{["Cloud", "Admin access", "Hardening"].map((c) => (
										<th key={c} scope="col" className="vx-eyebrow px-4 py-2.5" style={{ fontSize: 9, fontWeight: 400 }}>
											{c}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{CLOUDS.map((c, i) => (
									<tr key={c.name} style={{ borderBottom: i < CLOUDS.length - 1 ? "1px solid var(--border-faint)" : "none" }}>
										<th scope="row" className="px-4 py-[13px] text-[13px] font-medium text-text-primary">{c.name}</th>
										<td className="px-4 py-[13px] text-[11.5px] text-text-secondary" style={mono}>{c.access}</td>
										<td className="px-4 py-[13px] text-[11px] text-text-tertiary" style={mono}>{c.hardening}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			</Wrap>
		</section>
	);
}

/* ---------- 02 · What's open ---------- */

const CARD: CSSProperties = { border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", padding: "26px", boxShadow: "var(--shadow-sm)" };
const CARD_EYEBROW: CSSProperties = { ...mono, fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--text-tertiary)" };
const CARD_TITLE: CSSProperties = { ...disp, fontSize: 19, fontWeight: 600, margin: "10px 0 10px", color: "var(--text-primary)" };
const LINK_STYLE: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 13.5, color: "var(--text-secondary)", textDecoration: "none", borderBottom: "1px solid var(--border-strong)", paddingBottom: 2 };

/**
 * The two editions. The enterprise list follows /docs/editions/feature-matrix:
 * SSO, custom roles, Activity export, alerting and the managed runner pool are
 * licensed rows. The core card used to say "self-healing runners", which nothing
 * in the runner implements, and the enterprise card said "managed runners" —
 * one runner, two names. It is "the runner" and "the managed runner pool" now.
 */
function Editions() {
	return (
		<section className="py-[84px] max-[640px]:py-[64px]" style={{ borderBottom: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="02" label="What's open" />
				<h2 className="text-[34px] max-[640px]:text-[28px]" style={{ ...disp, fontWeight: 600, letterSpacing: "-0.035em", margin: "0 0 30px", color: "var(--text-primary)", maxWidth: 620 }}>
					Genuinely open source. One honest paid boundary.
				</h2>
				<div className="grid grid-cols-1 gap-5 md:grid-cols-2">
					<div style={CARD}>
						<span style={CARD_EYEBROW}>Core · AGPL-3.0</span>
						<h3 style={CARD_TITLE}>The whole platform, free.</h3>
						<p className="m-0 text-[14px] leading-[1.6] text-text-tertiary">
							Console, the <code style={{ ...mono, fontSize: 12.5 }}>alethia</code> CLI, the runner,
							multi-cloud provisioning and GitOps. OSI-approved open source, not source-available.
						</p>
					</div>
					<div style={CARD}>
						<span style={CARD_EYEBROW}>Enterprise · ee/</span>
						<h3 style={CARD_TITLE}>One directory, one license.</h3>
						<p className="m-0 text-[14px] leading-[1.6] text-text-tertiary">
							SSO, custom roles, audit export, alerting and the managed runner pool. The only
							commercially licensed code, kept apart by a CI boundary check.
						</p>
					</div>
				</div>
				<div className="mt-[22px] flex gap-5">
					<Link href="/docs/editions" style={LINK_STYLE}>Editions <Icon k="arrow" size={13} /></Link>
					<Link href="/docs/editions/licensing" style={LINK_STYLE}>Licensing <Icon k="arrow" size={13} /></Link>
				</div>
			</Wrap>
		</section>
	);
}

/* ---------- The trade, in one line ---------- */

/**
 * Was a "You run it / We run it" pair of lists. The "we run it" half named
 * zero-downtime upgrades, warm-pool scaling, an SLA and managed backups, none of
 * which this page could point to, so the whole section is one line now.
 */
function Ops() {
	return (
		<section className="py-14" style={{ borderBottom: "1px solid var(--border)", background: "var(--surface-sunken)" }}>
			<Wrap>
				<p className="m-0 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-ui-md text-text-secondary">
					<span>Self-hosting means the upgrades, backups and on-call are yours. Rather not? Use the hosted service.</span>
					<Link
						href="/pricing"
						className="vx-clamp vx-clamp--tight text-text-primary no-underline transition-colors hover:text-text-secondary"
					>
						Pricing ›
					</Link>
				</p>
			</Wrap>
		</section>
	);
}

/* ---------- 03 · Ways to run it ---------- */

const PATHS: { ic: IconKey; name: string; body: string; href: string }[] = [
	{ ic: "terminal", name: "Docker Compose", body: "One command on a fresh VM. The whole bundle behind Caddy.", href: "/docs/guides/self-hosting" },
	{ ic: "layers", name: "Terraform (per-cloud)", body: "Version-controlled OpenTofu, closed-origin behind a tunnel.", href: "/docs/guides/self-hosting/terraform" },
	{ ic: "node", name: "Helm", body: "The same bundle on an existing Kubernetes cluster.", href: "/docs/guides/self-hosting/helm" },
	{ ic: "zap", name: "One-click", body: "Launch on AWS or Azure from a prefilled template.", href: "/docs/guides/self-hosting/one-click" },
];

/** The four documented ways to run a self-hosted control plane. */
function DeployPaths() {
	return (
		<section className="py-[84px] max-[640px]:py-[64px]" style={{ borderBottom: "1px solid var(--border)" }}>
			<Wrap>
				<SecMark n="03" label="Ways to run it" />
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
					{PATHS.map((p) => (
						<Link key={p.name} href={p.href} style={{ display: "flex", gap: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", padding: "20px 22px", textDecoration: "none" }}>
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

/* ---------- Close ---------- */

/** The closing line, the docs and the repository. */
function Close({ stars }: { stars: number | null }) {
	return (
		<section style={{ padding: "92px 0" }}>
			<Wrap style={{ textAlign: "center" }}>
				<h2 style={{ ...disp, fontSize: 40, fontWeight: 600, letterSpacing: "-0.04em", margin: "0 0 16px", color: "var(--text-primary)" }}>Yours to run.</h2>
				<p style={{ fontSize: 15.5, color: "var(--text-tertiary)", lineHeight: 1.6, margin: "0 auto 28px", maxWidth: 440 }}>
					Clone it, read the source, deploy it on your own cloud. Open the docs or star the repo.
				</p>
				<div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
					<Button nativeButton={false} render={<Link href="/docs/guides/self-hosting" />}><Icon k="book" size={15} /> Self-host docs</Button>
					<Button variant="outline" nativeButton={false} render={<a href={REPO_URL} target="_blank" rel="noreferrer" />}><Icon k="git" size={15} /> {starLabel(stars)}</Button>
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
