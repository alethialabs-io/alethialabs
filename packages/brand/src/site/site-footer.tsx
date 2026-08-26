// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LEGAL_ENTITY } from "@repo/legal/entity";
import { PrivacySettingsButton } from "@repo/privacy/privacy-settings-button";
import Link from "next/link";

import { AlethiaLockup } from "../lockup";
import { eyebrow, mono, Wrap } from "./primitives";

/**
 * The site footer: two hairline rows, no link columns.
 *
 * It replaced a five-column directory of 32 links whose label→href map was a
 * 30-branch `if` chain that THREW at render time on any label it did not know —
 * a footer that could take the whole page down. A footer is a floor, not a
 * sitemap; everything it used to list is one click away through the header's
 * Product and Resources menus, or through `/sitemap.xml`.
 *
 * The legal row is deliberately not trimmed further. `Imprint` must stay easily
 * reachable under EU/BG law, and consent must stay as easy to withdraw as it was
 * to give — so `PrivacySettingsButton` is not a link we can drop for tidiness.
 * The legal documents that are no longer named here are cross-linked from
 * `LegalShell`, so none of them is orphaned.
 */

const NAV: { label: string; href: string; external?: boolean }[] = [
	{ label: "Docs", href: "/docs" },
	{ label: "Pricing", href: "/pricing" },
	{ label: "Enterprise", href: "/enterprise" },
	{ label: "Open source", href: "/open-source" },
	{ label: "Blog", href: "/blog" },
];

const LEGAL: { label: string; href: string }[] = [
	{ label: "Privacy", href: "/privacy" },
	{ label: "Terms", href: "/terms" },
	{ label: "Security", href: "/security" },
	{ label: "Imprint", href: "/imprint" },
];

const GITHUB_URL = "https://github.com/alethialabs-io/alethialabs";

const ROW: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "space-between",
	flexWrap: "wrap",
	gap: 18,
};

const LINK: React.CSSProperties = {
	...eyebrow,
	fontSize: 10,
	color: "var(--text-tertiary)",
	textDecoration: "none",
	padding: "3px 2px",
};

/** Public site footer. Rendered by every route through `SiteShell`. */
export function SiteFooter() {
	return (
		<footer
			style={{
				borderTop: "1px solid var(--border)",
				background: "var(--surface)",
				paddingTop: 40,
				paddingBottom: 36,
			}}
		>
			<Wrap>
				<div style={ROW}>
					<Link
						href="/"
						aria-label={`${LEGAL_ENTITY.tradingName} home`}
						style={{ textDecoration: "none", color: "inherit" }}
					>
						<AlethiaLockup size={24} />
					</Link>

					<nav
						aria-label="Footer"
						style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}
					>
						{NAV.map((it) => (
							<Link key={it.label} href={it.href} className="vx-clamp vx-clamp--tight" style={LINK}>
								{it.label}
							</Link>
						))}
						<a
							href={GITHUB_URL}
							target="_blank"
							rel="noreferrer"
							className="vx-clamp vx-clamp--tight"
							style={LINK}
						>
							GitHub
						</a>
					</nav>
				</div>

				<div style={{ height: 1, background: "var(--border)", margin: "28px 0 20px" }} />

				<div style={ROW}>
					<p style={{ ...eyebrow, ...mono, fontSize: 10, margin: 0 }}>
						© 2026 {LEGAL_ENTITY.tradingName} · AGPL-3.0 open core
					</p>

					<div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
						{LEGAL.map((it) => (
							<Link key={it.label} href={it.href} className="vx-clamp vx-clamp--tight" style={LINK}>
								{it.label}
							</Link>
						))}
						<PrivacySettingsButton
							className="vx-clamp vx-clamp--tight"
							style={{ ...LINK, background: "none", border: 0, cursor: "pointer" }}
						/>
					</div>
				</div>
			</Wrap>
		</footer>
	);
}
