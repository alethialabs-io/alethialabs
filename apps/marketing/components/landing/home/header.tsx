"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useState } from "react";
import Link from "next/link";
import { Menu } from "lucide-react";
import { Button } from "@repo/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@repo/ui/sheet";
import { ProviderIcon } from "@repo/ui/provider-icon";
import {
	disp,
	eyebrow,
	Icon,
	type IconKey,
	Lockup,
	mono,
	Wrap,
} from "./primitives";

const GITHUB_URL = "https://github.com/alethialabs-io/alethialabs";

interface MenuLink {
	ic: IconKey;
	name: string;
	desc: string;
	href?: string;
	badge?: boolean;
}
interface MenuGroup {
	group: string;
	items: MenuLink[];
}

const PRODUCT_MENU: MenuGroup[] = [
	{ group: "Platform", items: [
		{ ic: "grid", name: "Console", desc: "Visual control plane — configure, deploy, observe" },
		{ ic: "node", name: "Spec designer", desc: "Design infrastructure visually — form or canvas, live cost" },
		{ ic: "terminal", name: "alethia CLI", desc: "Plan, apply, and operate from your shell" },
	] },
	{ group: "Operate", items: [
		{ ic: "server", name: "Runners", desc: "Self-healing warm pools that execute provisioning jobs" },
		{ ic: "jobs", name: "Jobs", desc: "Every plan, apply, and teardown — streamed live" },
		{ ic: "bell", name: "Alerts", desc: "Policies match events; channels deliver them" },
	] },
	{ group: "Intelligence", items: [
		{ ic: "sparkles", name: "AI agent", desc: "An assistant that knows your infrastructure — ask or act" },
		{ ic: "scan", name: "Repo scanner", desc: "Point it at a repo; get a proposed Spec and cost" },
		{ ic: "plug", name: "MCP server", desc: "The same tools, exposed to Claude over MCP" },
	] },
	{ group: "Govern", items: [
		{ ic: "building", name: "Organizations & teams", desc: "Multi-tenant orgs, teams, and group-based grants" },
		{ ic: "key", name: "SSO — OIDC & SAML", desc: "Okta, Entra ID, IAM Identity Center" },
		{ ic: "shield", name: "Roles & RBAC", desc: "Custom roles, granular allow/deny, audit log" },
	] },
];

const PRODUCT_MENU_FOOT: { ic: IconKey; name: string }[] = [
	{ ic: "shield", name: "Zero-trust clouds" },
	{ ic: "git", name: "GitOps" },
];

const RESOURCE_MENU: MenuLink[] = [
	{ ic: "book", name: "Docs", desc: "Guides, concepts, and the full CLI reference", href: "/docs", badge: true },
	{ ic: "building", name: "About", desc: "The team and mission behind Alethia Labs", href: "/about" },
	{ ic: "pen", name: "Blog", desc: "Engineering notes and product updates", href: "/blog" },
	{ ic: "list", name: "Changelog", desc: "What shipped, every week", href: "/changelog" },
];

/** Formats a raw star count compactly (2400 → "2.4k", 950 → "950"). */
function formatStars(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + "k";
}

/** Single mega-menu entry row (icon tile + name + description). */
function MenuItem({ ic, name, desc, badge, href = "#" }: MenuLink) {
	const [h, setH] = useState(false);
	return (
		<Link
			href={href}
			onMouseEnter={() => setH(true)}
			onMouseLeave={() => setH(false)}
			style={{ display: "flex", gap: 12, padding: "10px 11px", borderRadius: "var(--radius-md)", background: h ? "var(--surface-muted)" : "transparent", textDecoration: "none", transition: "background .12s" }}
		>
			<span style={{ display: "grid", placeItems: "center", width: 34, height: 34, flexShrink: 0, borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", background: "var(--surface-sunken)", color: "var(--text-primary)" }}>
				<Icon k={ic} size={16} />
			</span>
			<div style={{ minWidth: 0 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span style={{ fontSize: 13.5, fontWeight: 500, color: "var(--text-primary)", ...disp }}>{name}</span>
					{badge && (
						<span style={{ ...mono, fontSize: 8.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-tertiary)", border: "1px solid var(--border-strong)", borderRadius: "var(--radius-xs)", padding: "1px 5px" }}>Start here</span>
					)}
				</div>
				<p style={{ fontSize: 11.5, color: "var(--text-tertiary)", margin: "3px 0 0", lineHeight: 1.4 }}>{desc}</p>
			</div>
		</Link>
	);
}

/** Hover-open dropdown wrapper for a nav item. */
function NavMenu({
	label,
	id,
	open,
	setOpen,
	width,
	children,
}: {
	label: string;
	id: string;
	open: string | null;
	setOpen: (v: string | null) => void;
	width: number;
	children: React.ReactNode;
}) {
	const active = open === id;
	return (
		<div onMouseEnter={() => setOpen(id)} onMouseLeave={() => setOpen(null)} style={{ position: "relative" }}>
			<button type="button" style={{ display: "flex", alignItems: "center", gap: 5, padding: "7px 12px", fontSize: 13.5, color: active ? "var(--text-primary)" : "var(--text-tertiary)", background: "transparent", border: "none", cursor: "pointer", borderRadius: "var(--radius-sm)", fontFamily: "inherit" }}>
				{label}
				<span style={{ display: "flex", transform: active ? "rotate(180deg)" : "none", transition: "transform .15s", opacity: 0.7 }}>
					<Icon k="chev" size={13} sw={2} />
				</span>
			</button>
			{active && (
				<div style={{ position: "absolute", top: "100%", left: 0, width, border: "1px solid var(--border)", borderRadius: "var(--radius-lg)", background: "var(--surface)", boxShadow: "var(--shadow-lg)", padding: 14, zIndex: 60, marginTop: 1 }}>
					{children}
				</div>
			)}
		</div>
	);
}

/** GitHub link with an optional live star count. */
function GitHubLink({ stars }: { stars?: number | null }) {
	return (
		<a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="ah-hide-sm" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-tertiary)", textDecoration: "none" }}>
			<ProviderIcon provider="github" size={16} />
			{stars != null && <span style={{ ...mono, fontSize: 12 }}>{formatStars(stars)}</span>}
		</a>
	);
}

const NAV_LINK_STYLE: React.CSSProperties = { padding: "7px 12px", fontSize: 13.5, color: "var(--text-tertiary)", borderRadius: "var(--radius-sm)", textDecoration: "none" };

/** Public site header — brand lockup, Product/Resources menus, Enterprise & Pricing links, GitHub, and CTAs. */
export function Header({ stars }: { stars?: number | null }) {
	const [open, setOpen] = useState<string | null>(null);
	const [mobile, setMobile] = useState(false);
	return (
		<header style={{ position: "sticky", top: 0, zIndex: 50, borderBottom: "1px solid var(--border)", background: "color-mix(in oklch, var(--background) 80%, transparent)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }}>
			<Wrap style={{ height: 62, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
				<Link href="/" style={{ textDecoration: "none" }}>
					<Lockup size={23} />
				</Link>

				<nav style={{ display: "flex", alignItems: "center", gap: 2 }} className="ah-navmenu">
					<NavMenu label="Product" id="product" open={open} setOpen={setOpen} width={880}>
						<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6 }}>
							{PRODUCT_MENU.map((col) => (
								<div key={col.group}>
									<p style={{ ...eyebrow, fontSize: 9.5, padding: "4px 11px 8px" }}>{col.group}</p>
									{col.items.map((it) => <MenuItem key={it.name} {...it} />)}
								</div>
							))}
						</div>
						<div style={{ borderTop: "1px solid var(--border-faint)", marginTop: 8, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 11px 4px", gap: 16 }}>
							<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
								<span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Also:</span>
								{PRODUCT_MENU_FOOT.map((f) => (
									<a key={f.name} href="#" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "4px 9px", textDecoration: "none" }}>
										<Icon k={f.ic} size={13} sw={1.6} />{f.name}
									</a>
								))}
							</div>
							<a href="#" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-primary)", whiteSpace: "nowrap", textDecoration: "none" }}>
								Platform tour <Icon k="arrow" size={13} />
							</a>
						</div>
					</NavMenu>

					<NavMenu label="Resources" id="resources" open={open} setOpen={setOpen} width={320}>
						{RESOURCE_MENU.map((it) => <MenuItem key={it.name} {...it} />)}
					</NavMenu>

					<Link href="/enterprise" style={NAV_LINK_STYLE}>Enterprise</Link>
					<Link href="/pricing" style={NAV_LINK_STYLE}>Pricing</Link>
				</nav>

				<div style={{ display: "flex", alignItems: "center", gap: 14 }}>
					<GitHubLink stars={stars} />
					<Link href="/contact/sales" className="ah-hide-sm">
						<Button variant="outline" size="sm">Get a demo</Button>
					</Link>
					<Link href="/signup">
						<Button size="sm">Get started <Icon k="arrow" size={14} /></Button>
					</Link>

					{/* mobile */}
					<Sheet open={mobile} onOpenChange={setMobile}>
						<SheetTrigger asChild>
							<Button variant="ghost" size="icon-sm" className="md:hidden">
								<Menu className="h-4 w-4" />
							</Button>
						</SheetTrigger>
						<SheetContent side="right" className="w-72 overflow-y-auto">
							<nav className="mt-8 flex flex-col gap-1">
								<p className="vx-eyebrow px-3 pb-1 pt-2">Product</p>
								{PRODUCT_MENU.flatMap((col) => col.items).map((it) => (
									<a key={it.name} href={it.href ?? "#"} onClick={() => setMobile(false)} className="rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary">
										{it.name}
									</a>
								))}
								<p className="vx-eyebrow px-3 pb-1 pt-3">Resources</p>
								{RESOURCE_MENU.map((it) => (
									<Link key={it.name} href={it.href ?? "#"} onClick={() => setMobile(false)} className="rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary">
										{it.name}
									</Link>
								))}
								<Link href="/enterprise" onClick={() => setMobile(false)} className="rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary">Enterprise</Link>
								<Link href="/pricing" onClick={() => setMobile(false)} className="rounded-md px-3 py-2 text-sm text-text-secondary hover:bg-surface-muted hover:text-text-primary">Pricing</Link>
								<div className="mt-3 flex flex-col gap-2 border-t border-border-faint pt-4">
									<Link href="/contact/sales" onClick={() => setMobile(false)}>
										<Button variant="outline" size="sm" className="w-full">Get a demo</Button>
									</Link>
									<Link href="/signup" onClick={() => setMobile(false)}>
										<Button size="sm" className="w-full">Get started</Button>
									</Link>
								</div>
							</nav>
						</SheetContent>
					</Sheet>
				</div>
			</Wrap>
		</header>
	);
}
