// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { LEGAL_ENTITY } from "@repo/legal/entity";
import { PrivacySettingsButton } from "@repo/privacy/privacy-settings-button";
import { ArrowUpRight } from "lucide-react";
import { SiteLink } from "./site-link";
import type { CSSProperties } from "react";

import { AlethiaLockup } from "../lockup";
import { eyebrow, mono, Wrap } from "./primitives";

/**
 * The site footer: the lockup and four short link columns, then a legal row.
 *
 * Every column is a typed `const` array rendered by one loop. The five-column
 * directory this family once replaced resolved its 32 labels through a 30-branch
 * `if` chain that THREW at render time on any label it did not know — a footer
 * that could take the whole page down. A list of `{ label, href }` cannot.
 *
 * The legal row is deliberately not trimmed further. `Imprint` must stay easily
 * reachable under EU/BG law, and consent must stay as easy to withdraw as it was
 * to give — so `PrivacySettingsButton` is not a link we can drop for tidiness.
 * The legal documents that are not named here are listed on `/legal` and
 * cross-linked from `LegalShell`, so none of them is orphaned.
 */

const GITHUB_URL = "https://github.com/alethialabs-io/alethialabs";

interface FooterLink {
	label: string;
	href: string;
	external?: boolean;
}

interface FooterColumn {
	title: string;
	links: FooterLink[];
}

const COLUMNS: FooterColumn[] = [
	{
		title: "Product",
		links: [
			// Docs is its own surface, so it opens in a new tab as the header's link does.
			{ label: "Docs", href: "/docs", external: true },
			{ label: "Pricing", href: "/pricing" },
			{ label: "Enterprise", href: "/enterprise" },
			{ label: "Open source", href: "/open-source" },
		],
	},
	{
		title: "News & updates",
		links: [
			{ label: "News", href: "/news" },
			{ label: "Changelog", href: `${GITHUB_URL}/releases`, external: true },
			{ label: "GitHub", href: GITHUB_URL, external: true },
		],
	},
	{
		title: "Company",
		links: [
			{ label: "About", href: "/about" },
			{ label: "Services", href: "/services" },
			{ label: "Contact", href: "/contact" },
			{ label: "Security", href: "/security" },
		],
	},
	{
		title: "Legal",
		links: [
			{ label: "Privacy", href: "/privacy" },
			{ label: "Terms", href: "/terms" },
			{ label: "Refunds", href: "/refunds" },
			{ label: "Imprint", href: "/imprint" },
			{ label: "All legal documents", href: "/legal" },
		],
	},
];

const LINK: CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	gap: 4,
	fontSize: 13,
	textDecoration: "none",
	transition: "color var(--dur-1) var(--ease)",
};

const LINK_CLASS = "text-text-secondary hover:text-text-primary focus-visible:text-text-primary";

/** One footer link; an off-site one opens in a new tab and says so. */
function FooterAnchor({ label, href, external }: FooterLink) {
	if (external) {
		return (
			<a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS} style={LINK}>
				{label}
				<ArrowUpRight aria-hidden size={12} strokeWidth={1.8} style={{ opacity: 0.7 }} />
				<span className="sr-only"> (opens in a new tab)</span>
			</a>
		);
	}
	return (
		<SiteLink href={href} className={LINK_CLASS} style={LINK}>
			{label}
		</SiteLink>
	);
}

/** Public site footer. Rendered by every route through `SiteShell`. */
export function SiteFooter() {
	return (
		<footer
			style={{
				borderTop: "1px solid var(--border)",
				background: "var(--surface)",
				paddingTop: 48,
				paddingBottom: 36,
			}}
		>
			<Wrap>
				<div className="flex flex-col gap-10 md:flex-row md:justify-between">
					<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
						<SiteLink
							href="/"
							aria-label={`${LEGAL_ENTITY.tradingName} home`}
							style={{ textDecoration: "none", color: "inherit", alignSelf: "flex-start" }}
						>
							<AlethiaLockup size={24} />
						</SiteLink>
						<p style={{ margin: 0, fontSize: 13, color: "var(--text-tertiary)" }}>
							Infrastructure, cross-examined.
						</p>
					</div>

					<nav
						aria-label="Footer"
						className="grid grid-cols-2 gap-x-12 gap-y-8 sm:grid-cols-4"
					>
						{COLUMNS.map((col) => (
							<div key={col.title} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
								<p style={{ ...eyebrow, fontSize: 10 }}>{col.title}</p>
								<ul
									style={{
										listStyle: "none",
										margin: 0,
										padding: 0,
										display: "flex",
										flexDirection: "column",
										gap: 8,
									}}
								>
									{col.links.map((it) => (
										<li key={it.label}>
											<FooterAnchor {...it} />
										</li>
									))}
								</ul>
							</div>
						))}
					</nav>
				</div>

				<div style={{ height: 1, background: "var(--border)", margin: "36px 0 20px" }} />

				<div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
					<p style={{ ...eyebrow, ...mono, fontSize: 10, margin: 0 }}>
						© 2026 {LEGAL_ENTITY.tradingName}
					</p>
					<PrivacySettingsButton
						className="vx-clamp vx-clamp--tight"
						style={{
							...eyebrow,
							fontSize: 10,
							color: "var(--text-tertiary)",
							padding: "3px 2px",
							background: "none",
							border: 0,
							cursor: "pointer",
						}}
					/>
				</div>
			</Wrap>
		</footer>
	);
}
