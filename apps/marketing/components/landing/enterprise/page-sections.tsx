// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { StatusBadge } from "@repo/ui/status-badge";
import {
	disp,
	eyebrow,
	HeroRail,
	Icon,
	type IconKey,
	Mark,
	mono,
	Prov,
	type ProviderId,
	Wrap,
} from "@/components/landing/home/primitives";

/* ---------- CTA destinations ---------- */
const SALES = "/contact/sales"; // matches the site header's "Get a demo"
const TRIAL = "/signup"; // the site's "Get started"
const SECURITY = "/docs"; // security / enterprise-setup documentation

/* ---------- shared bits ---------- */

/** Outline badge in the mono uppercase treatment the design uses (kit's `mono` prop). */
function MonoBadge({
	children,
	style,
}: {
	children: ReactNode;
	style?: CSSProperties;
}) {
	return (
		<Badge
			variant="outline"
			className="font-mono uppercase"
			style={{
				letterSpacing: "0.08em",
				borderColor: "var(--border-strong)",
				...style,
			}}
		>
			{children}
		</Badge>
	);
}

/** Numbered section eyebrow — "01 ── Label". */
function SecMark({ n, label }: { n: string; label: string }) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 12,
				marginBottom: 18,
			}}
		>
			<span
				style={{
					...mono,
					fontSize: 11,
					color: "var(--text-disabled)",
					letterSpacing: "0.1em",
				}}
			>
				{n}
			</span>
			<span
				style={{ width: 22, height: 1, background: "var(--border-strong)" }}
			/>
			<span style={{ ...eyebrow }}>{label}</span>
		</div>
	);
}

/** Authorization effect, read through shape + mono label — never hue. */
type EffectKey = "allow" | "deny" | "pending";
function Effect({ k }: { k: EffectKey }) {
	const map: Record<EffectKey, { status: string; label: string }> = {
		allow: { status: "active", label: "allow" },
		deny: { status: "failed", label: "deny" },
		pending: { status: "pending", label: "pending" },
	};
	const { status, label } = map[k];
	return <StatusBadge status={status} label={label} />;
}

/** Browser/console chrome that frames the hero product mock. */
function Frame({
	url,
	height,
	children,
}: {
	url: string;
	height: number;
	children: ReactNode;
}) {
	const nav: IconKey[] = ["grid", "users", "key", "shield", "audit", "sliders"];
	return (
		<div
			style={{
				border: "1px solid var(--border)",
				borderRadius: "var(--radius-xl)",
				overflow: "hidden",
				background: "var(--surface)",
				boxShadow: "var(--shadow-lg)",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 12,
					padding: "10px 14px",
					borderBottom: "1px solid var(--border)",
					background: "var(--surface-muted)",
				}}
			>
				<div style={{ display: "flex", gap: 6 }}>
					{[0, 1, 2].map((i) => (
						<span
							key={i}
							style={{
								width: 10,
								height: 10,
								borderRadius: 999,
								border: "1px solid var(--border-strong)",
							}}
						/>
					))}
				</div>
				<div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 7,
							padding: "4px 14px",
							borderRadius: "var(--radius-full)",
							border: "1px solid var(--border)",
							background: "var(--surface-sunken)",
							...mono,
							fontSize: 11,
							color: "var(--text-tertiary)",
						}}
					>
						<Icon k="lock" size={11} sw={1.7} />
						{url}
					</div>
				</div>
				<span
					style={{
						...mono,
						fontSize: 10,
						letterSpacing: "0.1em",
						textTransform: "uppercase",
						color: "var(--text-disabled)",
						width: 52,
						textAlign: "right",
					}}
				>
					ee
				</span>
			</div>
			<div style={{ display: "flex", height }}>
				<div
					className="en-hide-sm"
					style={{
						width: 50,
						borderRight: "1px solid var(--border)",
						background: "var(--surface-sunken)",
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: 4,
						padding: "14px 0",
						flexShrink: 0,
					}}
				>
					<span style={{ color: "var(--text-primary)", marginBottom: 8 }}>
						<Mark size={18} />
					</span>
					{nav.map((k, i) => (
						<span
							key={k}
							style={{
								display: "grid",
								placeItems: "center",
								width: 32,
								height: 32,
								borderRadius: "var(--radius-sm)",
								color: i === 2 ? "var(--text-primary)" : "var(--text-disabled)",
								background: i === 2 ? "var(--surface-muted)" : "transparent",
							}}
						>
							<Icon k={k} size={16} />
						</span>
					))}
				</div>
				<div
					style={{
						flex: 1,
						minWidth: 0,
						overflow: "hidden",
						display: "flex",
						flexDirection: "column",
					}}
				>
					{children}
				</div>
			</div>
		</div>
	);
}

/* ============ HERO ============ */

interface Grant {
	principal: string;
	role: string;
	scope: string;
	effect: EffectKey;
}
const GRANTS: Grant[] = [
	{
		principal: "team:platform",
		role: "admin",
		scope: "org · Acme Cloud",
		effect: "allow",
	},
	{
		principal: "team:payments",
		role: "operator",
		scope: "zone:production",
		effect: "allow",
	},
	{
		principal: "dana@acme.cloud",
		role: "viewer",
		scope: "spec:api-backend",
		effect: "allow",
	},
	{
		principal: "contractor@ext",
		role: "operator",
		scope: "zone:staging",
		effect: "allow",
	},
	{
		principal: "contractor@ext",
		role: "—",
		scope: "spec:* · destroy",
		effect: "deny",
	},
];

function GrantRow({ g, last }: { g: Grant; last: boolean }) {
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "1.4fr 0.8fr 1.3fr 0.7fr",
				alignItems: "center",
				gap: 8,
				padding: "11px 16px",
				borderBottom: last ? "none" : "1px solid var(--border-faint)",
			}}
		>
			<span
				style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
			>
				<Icon k="users" size={13} sw={1.7} />
				<code
					style={{
						...mono,
						fontSize: 11.5,
						color: "var(--text-primary)",
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
					}}
				>
					{g.principal}
				</code>
			</span>
			<span
				style={{
					...mono,
					fontSize: 11,
					color:
						g.role === "—" ? "var(--text-disabled)" : "var(--text-secondary)",
				}}
			>
				{g.role}
			</span>
			<code
				style={{
					...mono,
					fontSize: 11,
					color: "var(--text-tertiary)",
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
				}}
			>
				{g.scope}
			</code>
			<span style={{ justifySelf: "end" }}>
				<Effect k={g.effect} />
			</span>
		</div>
	);
}

function DecisionTrace() {
	const steps: [IconKey, string, string][] = [
		["check", "principal", "dana@acme.cloud"],
		["users", "member of", "team:payments"],
		["key", "team grants", "operator @ zone:production"],
		["shield", "operator allows", "spec apply"],
	];
	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					padding: "11px 15px",
					borderBottom: "1px solid var(--border)",
					background: "var(--surface-muted)",
				}}
			>
				<Icon k="shield" size={14} />
				<span
					style={{
						...disp,
						fontSize: 13,
						fontWeight: 600,
						color: "var(--text-primary)",
					}}
				>
					Authorization check
				</span>
				<span
					style={{
						...mono,
						fontSize: 9.5,
						color: "var(--text-tertiary)",
						marginLeft: "auto",
					}}
				>
					OpenFGA
				</span>
			</div>
			<div style={{ padding: "14px 15px", flex: 1 }}>
				<code
					style={{
						...mono,
						fontSize: 10.5,
						color: "var(--text-secondary)",
						lineHeight: 1.5,
						display: "block",
						marginBottom: 14,
					}}
				>
					<span style={{ color: "var(--text-tertiary)" }}>check(</span>
					can_apply, spec:api-backend
					<span style={{ color: "var(--text-tertiary)" }}>)</span>
				</code>
				<div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
					{steps.map(([ic, rel, val]) => (
						<div
							key={rel}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 10,
								padding: "6px 0",
							}}
						>
							<span
								style={{
									display: "grid",
									placeItems: "center",
									width: 22,
									height: 22,
									flexShrink: 0,
									borderRadius: "var(--radius-xs)",
									border: "1px solid var(--border)",
									background: "var(--surface-sunken)",
									color: "var(--text-secondary)",
								}}
							>
								<Icon k={ic} size={12} sw={1.7} />
							</span>
							<span
								style={{
									fontSize: 11,
									color: "var(--text-tertiary)",
									width: 78,
									flexShrink: 0,
								}}
							>
								{rel}
							</span>
							<code
								style={{
									...mono,
									fontSize: 11,
									color: "var(--text-primary)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
								}}
							>
								{val}
							</code>
						</div>
					))}
				</div>
			</div>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 10,
					padding: "12px 15px",
					borderTop: "1px solid var(--border)",
					background: "var(--surface-sunken)",
				}}
			>
				<Effect k="allow" />
				<span
					style={{
						...mono,
						fontSize: 10.5,
						color: "var(--text-tertiary)",
						marginLeft: "auto",
					}}
				>
					resolved · 4ms · logged
				</span>
			</div>
		</div>
	);
}

function Hero() {
	return (
		<section
			style={{
				position: "relative",
				paddingTop: 80,
				paddingBottom: 64,
				overflow: "hidden",
			}}
		>
			<div className="ah-grid-bg" />
			<Wrap style={{ position: "relative" }}>
				<div
					style={{
						textAlign: "center",
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						marginBottom: 52,
					}}
				>
					<HeroRail kicker="alethia · enterprise" status="governed" maxWidth={560} />
					<h1
						className="ah-h1"
						style={{
							...disp,
							fontSize: 58,
							fontWeight: 600,
							letterSpacing: "-0.045em",
							lineHeight: 1.04,
							margin: 0,
							maxWidth: 860,
							color: "var(--text-primary)",
						}}
					>
						Production access,
						<br />
						<span style={{ color: "var(--text-tertiary)" }}>
							on the record.
						</span>
					</h1>
					<p
						style={{
							fontSize: 18,
							color: "var(--text-secondary)",
							maxWidth: 620,
							margin: "24px 0 32px",
							lineHeight: 1.55,
						}}
					>
						Govern multi-cloud infrastructure for the whole organization —
						single sign-on, fine-grained roles, granular IAM, and a complete
						audit trail. Access maps to who actually needs it, and every
						decision is on the record.
					</p>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 13,
							flexWrap: "wrap",
							justifyContent: "center",
						}}
					>
						<Link href={SALES}>
							<Button>
								Contact sales <Icon k="arrow" size={15} />
							</Button>
						</Link>
						<Link href={TRIAL}>
							<Button variant="outline">Set up a trial</Button>
						</Link>
					</div>
				</div>
				<Frame url="console.alethialabs.io/access" height={358}>
					<div
						className="en-hero-grid"
						style={{
							display: "grid",
							gridTemplateColumns: "1.55fr 1fr",
							height: "100%",
						}}
					>
						<div
							style={{ display: "flex", flexDirection: "column", minWidth: 0 }}
						>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 8,
									padding: "11px 16px",
									borderBottom: "1px solid var(--border)",
									background: "var(--surface-muted)",
								}}
							>
								<Icon k="key" size={14} />
								<span
									style={{
										...disp,
										fontSize: 13,
										fontWeight: 600,
										color: "var(--text-primary)",
									}}
								>
									Grants
								</span>
								<span
									style={{
										...mono,
										fontSize: 9.5,
										color: "var(--text-tertiary)",
										marginLeft: "auto",
									}}
								>
									5 active · org Acme Cloud
								</span>
							</div>
							<div
								style={{
									display: "grid",
									gridTemplateColumns: "1.4fr 0.8fr 1.3fr 0.7fr",
									gap: 8,
									padding: "8px 16px",
									borderBottom: "1px solid var(--border-faint)",
									background: "var(--surface-sunken)",
								}}
							>
								{["Principal", "Role", "Scope", "Effect"].map((c) => (
									<span key={c} style={{ ...eyebrow, fontSize: 8.5 }}>
										{c}
									</span>
								))}
							</div>
							{GRANTS.map((g, i) => (
								<GrantRow
									key={`${g.principal}-${g.scope}`}
									g={g}
									last={i === GRANTS.length - 1}
								/>
							))}
						</div>
						<div
							className="en-hide-sm"
							style={{ borderLeft: "1px solid var(--border)" }}
						>
							<DecisionTrace />
						</div>
					</div>
				</Frame>
			</Wrap>
		</section>
	);
}

/* ============ PILLARS ============ */
function Pillars() {
	const items: [IconKey, string, string][] = [
		["key", "OIDC & SAML", "single sign-on"],
		["shield", "OpenFGA", "relationship RBAC"],
		["audit", "Every decision", "logged & exportable"],
		["building", "Self-managed", "runs in your VPC"],
	];
	return (
		<section
			style={{
				borderTop: "1px solid var(--border)",
				borderBottom: "1px solid var(--border)",
				background: "var(--surface-sunken)",
			}}
		>
			<Wrap>
				<div
					className="en-pillars"
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(4,1fr)",
						gap: 0,
					}}
				>
					{items.map(([ic, big, sub], i) => (
						<div
							key={big}
							className="en-pillar"
							style={{
								display: "flex",
								alignItems: "center",
								gap: 13,
								padding: "26px 0",
								borderLeft: i ? "1px solid var(--border)" : "none",
								paddingLeft: i ? 28 : 0,
							}}
						>
							<span
								style={{
									display: "grid",
									placeItems: "center",
									width: 38,
									height: 38,
									flexShrink: 0,
									borderRadius: "var(--radius-md)",
									border: "1px solid var(--border)",
									background: "var(--surface)",
									color: "var(--text-primary)",
								}}
							>
								<Icon k={ic} size={18} />
							</span>
							<div>
								<div
									style={{
										...disp,
										fontSize: 15,
										fontWeight: 600,
										color: "var(--text-primary)",
										letterSpacing: "-0.01em",
									}}
								>
									{big}
								</div>
								<div
									style={{
										...mono,
										fontSize: 10,
										letterSpacing: "0.06em",
										textTransform: "uppercase",
										color: "var(--text-tertiary)",
										marginTop: 3,
									}}
								>
									{sub}
								</div>
							</div>
						</div>
					))}
				</div>
			</Wrap>
		</section>
	);
}

/* ============ 01 · ORGANIZATIONS & TEAMS ============ */
function Orgs() {
	const teams: [string, number, string, string][] = [
		["Platform", 8, "admin", "org"],
		["Payments", 6, "operator", "zone:production"],
		["Data", 5, "operator", "zone:staging"],
		["Security", 3, "auditor", "org · read-only"],
	];
	const points: [string, string][] = [
		["Group-based grants", "Target a team, a zone, or a single spec"],
		["Least-privilege defaults", "New members land with the lowest role"],
		[
			"Membership is the source of truth",
			"Remove from the team, lose the access",
		],
	];
	return (
		<section
			style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}
		>
			<Wrap>
				<SecMark n="01" label="Organizations & teams" />
				<div
					className="ah-surface"
					style={{
						display: "grid",
						gridTemplateColumns: "1fr 1.1fr",
						gap: 56,
						alignItems: "center",
					}}
				>
					<div>
						<h2
							style={{
								...disp,
								fontSize: 36,
								fontWeight: 600,
								letterSpacing: "-0.035em",
								margin: "0 0 14px",
								color: "var(--text-primary)",
							}}
						>
							One org. Many teams. Grants that target groups, not people.
						</h2>
						<p
							style={{
								fontSize: 15,
								color: "var(--text-tertiary)",
								lineHeight: 1.65,
								margin: "0 0 22px",
								maxWidth: 440,
							}}
						>
							Multi-tenant organizations hold teams, zones, and specs. Invite a
							member once and add them to a team; aim a grant at the whole team
							and every member inherits it. People move between teams — the
							access follows the structure, not a spreadsheet.
						</p>
						<ul
							style={{
								listStyle: "none",
								padding: 0,
								margin: 0,
								display: "flex",
								flexDirection: "column",
								gap: 11,
							}}
						>
							{points.map(([t, d]) => (
								<li
									key={t}
									style={{ display: "flex", gap: 11, alignItems: "flex-start" }}
								>
									<span style={{ marginTop: 2, color: "var(--text-primary)" }}>
										<Icon k="check" size={15} sw={2.2} />
									</span>
									<span>
										<b
											style={{
												...disp,
												fontSize: 13.5,
												fontWeight: 600,
												color: "var(--text-primary)",
											}}
										>
											{t}.
										</b>{" "}
										<span
											style={{ fontSize: 13, color: "var(--text-tertiary)" }}
										>
											{d}
										</span>
									</span>
								</li>
							))}
						</ul>
					</div>
					<div
						style={{
							border: "1px solid var(--border)",
							borderRadius: "var(--radius-lg)",
							background: "var(--surface)",
							boxShadow: "var(--shadow-md)",
							overflow: "hidden",
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 11,
								padding: "14px 16px",
								borderBottom: "1px solid var(--border)",
								background: "var(--surface-muted)",
							}}
						>
							<span
								style={{
									display: "grid",
									placeItems: "center",
									width: 30,
									height: 30,
									borderRadius: "var(--radius-sm)",
									border: "1px solid var(--border)",
									background: "var(--surface)",
									...mono,
									fontSize: 11,
									fontWeight: 600,
									color: "var(--text-primary)",
								}}
							>
								AC
							</span>
							<div>
								<div
									style={{
										...disp,
										fontSize: 14,
										fontWeight: 600,
										color: "var(--text-primary)",
									}}
								>
									Acme Cloud
								</div>
								<div
									style={{
										...mono,
										fontSize: 10,
										color: "var(--text-tertiary)",
									}}
								>
									22 members · 4 teams
								</div>
							</div>
							<MonoBadge style={{ marginLeft: "auto" }}>Enterprise</MonoBadge>
						</div>
						{teams.map(([name, n, role, scope], i) => (
							<div
								key={name}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 13,
									padding: "14px 16px",
									borderBottom:
										i < teams.length - 1
											? "1px solid var(--border-faint)"
											: "none",
								}}
							>
								<span
									style={{
										display: "grid",
										placeItems: "center",
										width: 32,
										height: 32,
										flexShrink: 0,
										borderRadius: "var(--radius-sm)",
										border: "1px solid var(--border)",
										background: "var(--surface-sunken)",
										color: "var(--text-secondary)",
									}}
								>
									<Icon k="users" size={15} />
								</span>
								<div style={{ minWidth: 0 }}>
									<div
										style={{
											...disp,
											fontSize: 13.5,
											fontWeight: 600,
											color: "var(--text-primary)",
										}}
									>
										team:{name.toLowerCase()}
									</div>
									<div
										style={{
											...mono,
											fontSize: 10.5,
											color: "var(--text-tertiary)",
										}}
									>
										{n} members
									</div>
								</div>
								<div style={{ marginLeft: "auto", textAlign: "right" }}>
									<div
										style={{
											...mono,
											fontSize: 11,
											color: "var(--text-primary)",
										}}
									>
										{role}
									</div>
									<code
										style={{
											...mono,
											fontSize: 9.5,
											color: "var(--text-tertiary)",
										}}
									>
										{scope}
									</code>
								</div>
							</div>
						))}
					</div>
				</div>
			</Wrap>
		</section>
	);
}

/* ============ 02 · SINGLE SIGN-ON ============ */
function SSO() {
	const idps = [
		"Okta",
		"Microsoft Entra ID",
		"AWS IAM Identity Center",
		"Google Workspace",
		"OneLogin",
		"Ping Identity",
	];
	const cfg: [string, string][] = [
		["Protocol", "OIDC · SAML 2.0"],
		["Provisioning", "SCIM 2.0"],
		["Enforced domains", "acme.cloud · acme.io"],
		["First-login role", "viewer · least privilege"],
		["Just-in-time", "on"],
	];
	const tiles: [IconKey, string, string][] = [
		["users", "SCIM provisioning", "Users and groups sync from your directory"],
		["lock", "Enforced SSO", "Password login disabled org-wide"],
	];
	return (
		<section
			style={{
				padding: "84px 0",
				borderTop: "1px solid var(--border)",
				background: "var(--surface-sunken)",
			}}
		>
			<Wrap>
				<SecMark n="02" label="Single sign-on" />
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "flex-end",
						gap: 24,
						flexWrap: "wrap",
						marginBottom: 36,
					}}
				>
					<h2
						style={{
							...disp,
							fontSize: 36,
							fontWeight: 600,
							letterSpacing: "-0.035em",
							margin: 0,
							maxWidth: 560,
							color: "var(--text-primary)",
						}}
					>
						Bring your identity provider. Provision and de-provision
						automatically.
					</h2>
					<p
						style={{
							fontSize: 15,
							color: "var(--text-tertiary)",
							maxWidth: 380,
							margin: 0,
							lineHeight: 1.6,
						}}
					>
						Enforce SSO across the org over OIDC or SAML. SCIM keeps membership
						in sync — when someone leaves your directory, their access leaves
						Alethia.
					</p>
				</div>
				<div
					className="ah-2col"
					style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}
				>
					<div
						style={{
							border: "1px solid var(--border)",
							borderRadius: "var(--radius-lg)",
							background: "var(--surface)",
							overflow: "hidden",
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 9,
								padding: "13px 16px",
								borderBottom: "1px solid var(--border)",
								background: "var(--surface-muted)",
							}}
						>
							<Icon k="key" size={15} />
							<span
								style={{
									...disp,
									fontSize: 14,
									fontWeight: 600,
									color: "var(--text-primary)",
								}}
							>
								SSO connection
							</span>
							<span style={{ marginLeft: "auto" }}>
								<StatusBadge status="active" label="enforced" />
							</span>
						</div>
						<div style={{ padding: "6px 16px" }}>
							{cfg.map(([k, v], i) => (
								<div
									key={k}
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										gap: 12,
										padding: "12px 0",
										borderBottom:
											i < cfg.length - 1
												? "1px solid var(--border-faint)"
												: "none",
									}}
								>
									<span
										style={{ fontSize: 12.5, color: "var(--text-tertiary)" }}
									>
										{k}
									</span>
									<code
										style={{
											...mono,
											fontSize: 12,
											color: "var(--text-primary)",
											textAlign: "right",
										}}
									>
										{v}
									</code>
								</div>
							))}
						</div>
					</div>
					<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
						<div
							style={{
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-lg)",
								background: "var(--surface)",
								padding: "18px 18px 20px",
								flex: 1,
							}}
						>
							<div style={{ ...eyebrow, fontSize: 9, marginBottom: 14 }}>
								Tested with
							</div>
							<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
								{idps.map((p) => (
									<span
										key={p}
										style={{
											...mono,
											fontSize: 11.5,
											color: "var(--text-secondary)",
											border: "1px solid var(--border-strong)",
											borderRadius: "var(--radius-sm)",
											padding: "6px 11px",
											background: "var(--surface-muted)",
										}}
									>
										{p}
									</span>
								))}
							</div>
							<p
								style={{
									fontSize: 12.5,
									color: "var(--text-tertiary)",
									lineHeight: 1.6,
									margin: "16px 0 0",
								}}
							>
								Standards-based — any compliant OIDC or SAML provider works. No
								per-IdP integration to wait on.
							</p>
						</div>
						<div
							style={{
								display: "grid",
								gridTemplateColumns: "1fr 1fr",
								gap: 16,
							}}
						>
							{tiles.map(([ic, t, d]) => (
								<div
									key={t}
									style={{
										border: "1px solid var(--border)",
										borderRadius: "var(--radius-lg)",
										background: "var(--surface)",
										padding: "16px 16px 18px",
									}}
								>
									<span
										style={{
											display: "grid",
											placeItems: "center",
											width: 32,
											height: 32,
											borderRadius: "var(--radius-sm)",
											border: "1px solid var(--border)",
											background: "var(--surface-muted)",
											color: "var(--text-primary)",
											marginBottom: 11,
										}}
									>
										<Icon k={ic} size={16} />
									</span>
									<div
										style={{
											...disp,
											fontSize: 13.5,
											fontWeight: 600,
											color: "var(--text-primary)",
											marginBottom: 4,
										}}
									>
										{t}
									</div>
									<p
										style={{
											fontSize: 11.5,
											color: "var(--text-tertiary)",
											lineHeight: 1.5,
											margin: 0,
										}}
									>
										{d}
									</p>
								</div>
							))}
						</div>
					</div>
				</div>
			</Wrap>
		</section>
	);
}

/* ============ 03 · ROLES & RBAC ============ */
const CAPS = ["View", "Plan", "Apply", "Destroy", "Access", "Billing"];
interface Role {
	name: string;
	caps: number[];
	custom: boolean;
}
const ROLES: Role[] = [
	{ name: "owner", caps: [1, 1, 1, 1, 1, 1], custom: false },
	{ name: "admin", caps: [1, 1, 1, 1, 1, 1], custom: false },
	{ name: "operator", caps: [1, 1, 1, 0, 0, 0], custom: false },
	{ name: "viewer", caps: [1, 0, 0, 0, 0, 0], custom: false },
	{ name: "auditor", caps: [1, 0, 0, 0, 1, 0], custom: true },
	{ name: "billing", caps: [1, 0, 0, 0, 0, 1], custom: true },
];
function Cell({ on }: { on: boolean }) {
	return on ? (
		<span
			style={{
				display: "inline-block",
				width: 11,
				height: 11,
				background: "var(--text-primary)",
				borderRadius: 2,
			}}
		/>
	) : (
		<span
			style={{
				display: "inline-block",
				width: 11,
				height: 11,
				border: "1px solid var(--border-strong)",
				borderRadius: 2,
				background: "transparent",
			}}
		/>
	);
}
function Rbac() {
	const grid = "1.1fr repeat(6, 1fr)";
	return (
		<section
			style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}
		>
			<Wrap>
				<SecMark n="03" label="Roles & RBAC" />
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "flex-end",
						gap: 24,
						flexWrap: "wrap",
						marginBottom: 36,
					}}
				>
					<h2
						style={{
							...disp,
							fontSize: 36,
							fontWeight: 600,
							letterSpacing: "-0.035em",
							margin: 0,
							maxWidth: 560,
							color: "var(--text-primary)",
						}}
					>
						Four roles out of the box. Define your own when four isn&apos;t
						enough.
					</h2>
					<p
						style={{
							fontSize: 15,
							color: "var(--text-tertiary)",
							maxWidth: 380,
							margin: 0,
							lineHeight: 1.6,
						}}
					>
						owner, admin, operator, and viewer cover most teams. Custom roles
						compose allow and deny down to a single capability — evaluated by
						OpenFGA over Postgres RBAC.
					</p>
				</div>
				<div
					style={{
						border: "1px solid var(--border)",
						borderRadius: "var(--radius-lg)",
						overflow: "hidden",
						background: "var(--surface)",
					}}
				>
					<div
						style={{
							display: "grid",
							gridTemplateColumns: grid,
							padding: "12px 18px",
							borderBottom: "1px solid var(--border)",
							background: "var(--surface-muted)",
						}}
					>
						<span style={{ ...eyebrow, fontSize: 9 }}>Role</span>
						{CAPS.map((c) => (
							<span
								key={c}
								style={{ ...eyebrow, fontSize: 9, textAlign: "center" }}
							>
								{c}
							</span>
						))}
					</div>
					{ROLES.map((role, i) => (
						<div
							key={role.name}
							style={{
								display: "grid",
								gridTemplateColumns: grid,
								alignItems: "center",
								padding: "14px 18px",
								borderBottom:
									i < ROLES.length - 1
										? "1px solid var(--border-faint)"
										: "none",
							}}
						>
							<span style={{ display: "flex", alignItems: "center", gap: 9 }}>
								<code
									style={{
										...mono,
										fontSize: 12.5,
										color: "var(--text-primary)",
										fontWeight: 500,
									}}
								>
									{role.name}
								</code>
								{role.custom && (
									<span
										style={{
											...mono,
											fontSize: 8,
											letterSpacing: "0.1em",
											textTransform: "uppercase",
											color: "var(--text-tertiary)",
											border: "1px solid var(--border-strong)",
											borderRadius: "var(--radius-xs)",
											padding: "1px 5px",
										}}
									>
										custom
									</span>
								)}
							</span>
							{role.caps.map((c, k) => (
								<span
									key={CAPS[k]}
									style={{ display: "grid", placeItems: "center" }}
								>
									<Cell on={c === 1} />
								</span>
							))}
						</div>
					))}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 20,
							padding: "13px 18px",
							background: "var(--surface-sunken)",
							borderTop: "1px solid var(--border)",
							flexWrap: "wrap",
						}}
					>
						<span
							style={{
								display: "flex",
								alignItems: "center",
								gap: 8,
								...mono,
								fontSize: 10.5,
								color: "var(--text-tertiary)",
							}}
						>
							<Cell on={true} /> allow
						</span>
						<span
							style={{
								display: "flex",
								alignItems: "center",
								gap: 8,
								...mono,
								fontSize: 10.5,
								color: "var(--text-tertiary)",
							}}
						>
							<Cell on={false} /> deny
						</span>
						<span
							style={{
								marginLeft: "auto",
								display: "flex",
								alignItems: "center",
								gap: 8,
								...mono,
								fontSize: 10.5,
								color: "var(--text-disabled)",
							}}
						>
							<Icon k="sliders" size={13} sw={1.7} />
							Grants scope a role to org, zone, or a single spec
						</span>
					</div>
				</div>
			</Wrap>
		</section>
	);
}

/* ============ 04 · AUDIT LOG ============ */
type AuditRow = [string, string, string, EffectKey, string, string];
const AUDIT: AuditRow[] = [
	[
		"dana@acme.cloud",
		"spec apply",
		"spec:api-backend",
		"allow",
		"team:payments#operator",
		"2m ago",
	],
	[
		"sam@acme.cloud",
		"spec destroy",
		"spec:edge-cache",
		"deny",
		"operator ∌ destroy",
		"14m ago",
	],
	[
		"SCIM · Okta",
		"member provisioned",
		"ext@acme.cloud",
		"allow",
		"directory sync",
		"38m ago",
	],
	[
		"ivan@acme.cloud",
		"access requested",
		"zone:staging",
		"pending",
		"self-serve portal",
		"1h ago",
	],
	[
		"jordan@acme.cloud",
		"sso login",
		"OIDC · Okta",
		"allow",
		"enforced domain",
		"1h ago",
	],
	[
		"maya@acme.cloud",
		"role updated",
		"operator → admin",
		"allow",
		"owner",
		"3h ago",
	],
];
function Audit() {
	const cols = ["Principal", "Action", "Resource", "Effect", "Via", "When"];
	const grid = "1.25fr 1.05fr 1.2fr 0.75fr 1.2fr 0.7fr";
	return (
		<section
			style={{
				padding: "84px 0",
				borderTop: "1px solid var(--border)",
				background: "var(--surface-sunken)",
			}}
		>
			<Wrap>
				<SecMark n="04" label="Audit log" />
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "flex-end",
						gap: 24,
						flexWrap: "wrap",
						marginBottom: 36,
					}}
				>
					<h2
						style={{
							...disp,
							fontSize: 36,
							fontWeight: 600,
							letterSpacing: "-0.035em",
							margin: 0,
							maxWidth: 540,
							color: "var(--text-primary)",
						}}
					>
						Every authorization decision, written down.
					</h2>
					<p
						style={{
							fontSize: 15,
							color: "var(--text-tertiary)",
							maxWidth: 380,
							margin: 0,
							lineHeight: 1.6,
						}}
					>
						Who, what, on which resource, allowed or denied, and the grant that
						decided it. Stream it live, filter it, and export it for compliance.
					</p>
				</div>
				<div
					style={{
						border: "1px solid var(--border)",
						borderRadius: "var(--radius-lg)",
						overflow: "hidden",
						background: "var(--surface)",
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 10,
							padding: "12px 18px",
							borderBottom: "1px solid var(--border)",
							background: "var(--surface-muted)",
						}}
					>
						<Icon k="audit" size={15} />
						<span
							style={{
								...disp,
								fontSize: 14,
								fontWeight: 600,
								color: "var(--text-primary)",
							}}
						>
							Audit log
						</span>
						<span
							style={{ ...mono, fontSize: 10, color: "var(--text-tertiary)" }}
						>
							org Acme Cloud
						</span>
						<span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
							<Button variant="outline" size="sm">
								<Icon k="list" size={13} sw={1.7} />
								Filter
							</Button>
							<Button variant="outline" size="sm">
								<Icon k="arrow" size={13} />
								Export CSV
							</Button>
						</span>
					</div>
					<div
						className="en-audit-head"
						style={{
							display: "grid",
							gridTemplateColumns: grid,
							padding: "9px 18px",
							borderBottom: "1px solid var(--border)",
							background: "var(--surface-sunken)",
						}}
					>
						{cols.map((c) => (
							<span key={c} style={{ ...eyebrow, fontSize: 8.5 }}>
								{c}
							</span>
						))}
					</div>
					{AUDIT.map((r, i) => (
						<div
							key={`${r[0]}-${r[5]}`}
							style={{
								display: "grid",
								gridTemplateColumns: grid,
								alignItems: "center",
								padding: "13px 18px",
								borderBottom:
									i < AUDIT.length - 1
										? "1px solid var(--border-faint)"
										: "none",
							}}
						>
							<code
								style={{
									...mono,
									fontSize: 11.5,
									color: "var(--text-primary)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
								}}
							>
								{r[0]}
							</code>
							<span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
								{r[1]}
							</span>
							<code
								style={{
									...mono,
									fontSize: 11,
									color: "var(--text-tertiary)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
								}}
							>
								{r[2]}
							</code>
							<span>
								<Effect k={r[3]} />
							</span>
							<code
								style={{
									...mono,
									fontSize: 10.5,
									color: "var(--text-tertiary)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
								}}
							>
								{r[4]}
							</code>
							<span
								style={{ ...mono, fontSize: 11, color: "var(--text-disabled)" }}
							>
								{r[5]}
							</span>
						</div>
					))}
				</div>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 9,
						marginTop: 18,
						...mono,
						fontSize: 11,
						color: "var(--text-tertiary)",
					}}
				>
					<Icon k="lock" size={13} sw={1.7} />
					<span>
						Append-only · tamper-evident · streamable to your SIEM via webhook.
					</span>
				</div>
			</Wrap>
		</section>
	);
}

/* ============ 05 · SECURITY & DEPLOYMENT ============ */
function Security() {
	const trust: [ProviderId, string, string, string][] = [
		["aws", "AWS", "Cross-account IAM role", "AssumeRole"],
		["gcp", "Google Cloud", "Workload Identity Federation", "WIF"],
		["azure", "Azure", "Federated identity", "OIDC"],
	];
	const tiles: [IconKey, string, string][] = [
		[
			"building",
			"Self-managed license",
			"Run the entire control plane in your own VPC — single-tenant or air-gapped. Your data never leaves your cloud.",
		],
		[
			"gauge",
			"99.9% uptime SLA",
			"Contractual availability on hosted plans, with credits and a public status page.",
		],
		[
			"users",
			"Dedicated support",
			"A named contact, a shared channel, and onboarding — not a ticket queue.",
		],
		[
			"shield",
			"Granular IAM · Access portal",
			"Allow and deny down to a single spec or zone. Members request access; approvals are one click and logged.",
		],
	];
	return (
		<section
			style={{ padding: "84px 0", borderTop: "1px solid var(--border)" }}
		>
			<Wrap>
				<SecMark n="05" label="Security & deployment" />
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "flex-end",
						gap: 24,
						flexWrap: "wrap",
						marginBottom: 36,
					}}
				>
					<h2
						style={{
							...disp,
							fontSize: 36,
							fontWeight: 600,
							letterSpacing: "-0.035em",
							margin: 0,
							maxWidth: 560,
							color: "var(--text-primary)",
						}}
					>
						Zero credentials stored. Deploy it where your data lives.
					</h2>
					<p
						style={{
							fontSize: 15,
							color: "var(--text-tertiary)",
							maxWidth: 380,
							margin: 0,
							lineHeight: 1.6,
						}}
					>
						Every cloud connects through short-lived federated identity — no
						access keys on disk or in our database. Run Alethia hosted, or
						self-managed entirely inside your perimeter.
					</p>
				</div>
				<div
					className="ah-3col"
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(3,1fr)",
						gap: 16,
						marginBottom: 16,
					}}
				>
					{trust.map(([id, name, method, tag]) => (
						<div
							key={id}
							style={{
								border: "1px solid var(--border)",
								borderRadius: "var(--radius-lg)",
								background: "var(--surface)",
								padding: "18px 18px 20px",
							}}
						>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 11,
									marginBottom: 16,
								}}
							>
								<span
									style={{
										display: "grid",
										placeItems: "center",
										width: 36,
										height: 36,
										borderRadius: "var(--radius-sm)",
										border: "1px solid var(--border)",
										background: "var(--surface-muted)",
									}}
								>
									<Prov id={id} size={19} />
								</span>
								<span style={{ marginLeft: "auto" }}>
									<MonoBadge>{tag}</MonoBadge>
								</span>
							</div>
							<h3
								style={{
									...disp,
									fontSize: 15.5,
									fontWeight: 600,
									margin: "0 0 5px",
									color: "var(--text-primary)",
								}}
							>
								{name}
							</h3>
							<p
								style={{
									fontSize: 12.5,
									color: "var(--text-tertiary)",
									margin: "0 0 14px",
									lineHeight: 1.5,
								}}
							>
								{method}
							</p>
							<span
								style={{
									...mono,
									fontSize: 10.5,
									color: "var(--text-disabled)",
									display: "flex",
									alignItems: "center",
									gap: 6,
								}}
							>
								<Icon k="lock" size={11} sw={1.7} />
								no static keys
							</span>
						</div>
					))}
				</div>
				<div
					className="en-deploy"
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(4,1fr)",
						gap: 0,
						border: "1px solid var(--border)",
						borderRadius: "var(--radius-lg)",
						overflow: "hidden",
						background: "var(--surface)",
					}}
				>
					{tiles.map(([ic, title, body], i) => (
						<div
							key={title}
							className="en-deploy-cell"
							style={{
								padding: "22px 20px 24px",
								borderLeft: i ? "1px solid var(--border)" : "none",
							}}
						>
							<span
								style={{
									display: "grid",
									placeItems: "center",
									width: 36,
									height: 36,
									borderRadius: "var(--radius-md)",
									border: "1px solid var(--border)",
									background: "var(--surface-muted)",
									color: "var(--text-primary)",
									marginBottom: 14,
								}}
							>
								<Icon k={ic} size={17} />
							</span>
							<h3
								style={{
									...disp,
									fontSize: 15,
									fontWeight: 600,
									margin: "0 0 7px",
									color: "var(--text-primary)",
								}}
							>
								{title}
							</h3>
							<p
								style={{
									fontSize: 12,
									color: "var(--text-tertiary)",
									lineHeight: 1.55,
									margin: 0,
								}}
							>
								{body}
							</p>
						</div>
					))}
				</div>
			</Wrap>
		</section>
	);
}

/* ============ 06 · ENTERPRISE PLAN BAND ============ */
function PlanBand() {
	const inc = [
		"SSO / SAML + SCIM",
		"Custom roles · OpenFGA",
		"Granular IAM + Access portal",
		"Audit log export",
		"Unlimited concurrent jobs",
		"Self-managed license",
		"99.9% SLA + dedicated support",
	];
	return (
		<section
			style={{
				padding: "84px 0",
				borderTop: "1px solid var(--border)",
				background: "var(--surface-sunken)",
			}}
		>
			<Wrap>
				<div
					style={{
						border: "1px solid var(--border)",
						borderRadius: "var(--radius-xl)",
						overflow: "hidden",
						background: "var(--surface)",
						boxShadow: "var(--shadow-md)",
					}}
				>
					<div
						className="en-plan"
						style={{ display: "grid", gridTemplateColumns: "1fr 1.25fr" }}
					>
						<div
							className="en-plan-left"
							style={{
								padding: "34px 34px 36px",
								borderRight: "1px solid var(--border)",
							}}
						>
							<div style={{ ...eyebrow, fontSize: 9.5, marginBottom: 16 }}>
								Enterprise plan
							</div>
							<div
								style={{
									...disp,
									fontSize: 32,
									fontWeight: 600,
									letterSpacing: "-0.035em",
									color: "var(--text-primary)",
									lineHeight: 1.1,
								}}
							>
								Built around your org.
							</div>
							<p
								style={{
									fontSize: 13.5,
									color: "var(--text-tertiary)",
									margin: "12px 0 24px",
									lineHeight: 1.55,
									maxWidth: 280,
								}}
							>
								Annual, with a self-managed option. Scoped to your teams, your
								identity provider, and where your data has to live.
							</p>
							<div
								style={{ display: "flex", flexDirection: "column", gap: 10 }}
							>
								<Link href={SALES}>
									<Button style={{ width: "100%", justifyContent: "center" }}>
										Contact sales <Icon k="arrow" size={15} />
									</Button>
								</Link>
								<Link href={TRIAL}>
									<Button
										variant="outline"
										style={{ width: "100%", justifyContent: "center" }}
									>
										Set up a trial
									</Button>
								</Link>
							</div>
						</div>
						<div style={{ padding: "34px 34px 36px" }}>
							<div style={{ ...eyebrow, fontSize: 9.5, marginBottom: 16 }}>
								Everything in Business, plus
							</div>
							<div
								className="en-plan-inc"
								style={{
									display: "grid",
									gridTemplateColumns: "1fr 1fr",
									gap: "13px 20px",
								}}
							>
								{inc.map((t) => (
									<div
										key={t}
										style={{
											display: "flex",
											gap: 10,
											alignItems: "flex-start",
										}}
									>
										<span
											style={{
												marginTop: 1,
												color: "var(--text-primary)",
												flexShrink: 0,
											}}
										>
											<Icon k="check" size={15} sw={2.2} />
										</span>
										<span
											style={{
												fontSize: 13,
												color: "var(--text-secondary)",
												lineHeight: 1.4,
											}}
										>
											{t}
										</span>
									</div>
								))}
							</div>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 9,
									marginTop: 24,
									paddingTop: 18,
									borderTop: "1px solid var(--border-faint)",
									...mono,
									fontSize: 11,
									color: "var(--text-tertiary)",
								}}
							>
								<Icon k="git" size={13} sw={1.7} />
								<span>
									Open core — community RBAC ships free under AGPL-3.0.
									Governance is the commercial{" "}
									<code style={{ color: "var(--text-secondary)" }}>ee/</code>{" "}
									tier.
								</span>
							</div>
						</div>
					</div>
				</div>
			</Wrap>
		</section>
	);
}

/* ============ CLOSING CTA ============ */
function CTA() {
	return (
		<section
			style={{
				padding: "96px 0",
				borderTop: "1px solid var(--border)",
				position: "relative",
				overflow: "hidden",
			}}
		>
			<div className="ah-grid-bg ah-grid-cta" />
			<Wrap
				style={{
					position: "relative",
					textAlign: "center",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
				}}
			>
				<Mark size={34} />
				<h2
					style={{
						...disp,
						fontSize: 42,
						fontWeight: 600,
						letterSpacing: "-0.04em",
						margin: "22px 0 16px",
						maxWidth: 620,
						color: "var(--text-primary)",
						lineHeight: 1.05,
					}}
				>
					Talk to us about governance at scale.
				</h2>
				<p
					style={{
						fontSize: 16.5,
						color: "var(--text-secondary)",
						maxWidth: 500,
						margin: "0 0 34px",
						lineHeight: 1.55,
					}}
				>
					Tell us about your org, your identity provider, and where your data
					has to live. We&apos;ll map it to Alethia.
				</p>
				<div
					style={{
						display: "flex",
						gap: 13,
						alignItems: "center",
						flexWrap: "wrap",
						justifyContent: "center",
					}}
				>
					<Link href={SALES}>
						<Button>
							Contact sales <Icon k="arrow" size={15} />
						</Button>
					</Link>
					<Link href={SECURITY}>
						<Button variant="outline">
							<Icon k="book" size={15} />
							Security overview
						</Button>
					</Link>
				</div>
			</Wrap>
		</section>
	);
}

/**
 * Enterprise-governance marketing page body. Renders as a flat list of
 * `<section>` elements so the home `Reveal` wrapper can scroll-reveal each one
 * (the first — the hero — is left visible). Mirrors the design kit's
 * `ui_kits/alethia-labs-site/Enterprise.html`.
 */
export function EnterpriseSections() {
	return (
		<>
			<Hero />
			<Pillars />
			<Orgs />
			<SSO />
			<Rbac />
			<Audit />
			<Security />
			<PlanBand />
			<CTA />
		</>
	);
}
