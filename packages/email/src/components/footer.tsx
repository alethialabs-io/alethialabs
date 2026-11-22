// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Link, Section, Text } from "@react-email/components";
import { env } from "next-runtime-env";
import type { ReactNode } from "react";
import { Mark } from "./mark";
import { colors, fonts } from "./theme";

/** One link in the footer row. */
interface FootLink {
	label: string;
	href: string;
}

/**
 * The footer's resource links. The Status link is the configured status page (`NEXT_PUBLIC_STATUS_URL`,
 * the same variable the console's `statusUrl()` reads) and is OMITTED when none is configured: it used to
 * hard-code status.alethialabs.io, which had no DNS record, and a self-hoster's mail has no business
 * pointing at our status page at all.
 */
function footLinks(statusUrl: string | null | undefined): FootLink[] {
	const links: FootLink[] = [
		{ label: "Documentation", href: "https://alethialabs.io/docs" },
		{ label: "Console", href: "https://alethialabs.io" },
		{ label: "GitHub", href: "https://github.com/alethialabs-io" },
	];
	if (statusUrl) links.push({ label: "Status", href: statusUrl });
	return links;
}

interface EmailFooterProps {
	/** Per-email legal/explanatory line (why this email was sent). */
	legal: ReactNode;
	/** The status page to link; defaults to `NEXT_PUBLIC_STATUS_URL`. Empty or unset hides the link. */
	statusUrl?: string | null;
}

/** Shared email footer — mark, resource links, legal line, copyright. */
export function EmailFooter({ legal, statusUrl = env("NEXT_PUBLIC_STATUS_URL") }: EmailFooterProps) {
	return (
		<Section
			className="a-border"
			style={{
				padding: "28px 40px 34px",
				borderTop: `1px solid ${colors.border}`,
			}}
		>
			<Section style={{ marginBottom: "16px" }}>
				<Mark size={18} color={colors.textSecondary} />
				<span
					className="a-text-2"
					style={{
						fontFamily: fonts.sans,
						fontSize: "14px",
						fontWeight: 600,
						color: colors.textSecondary,
						verticalAlign: "middle",
						marginLeft: "9px",
					}}
				>
					Alethia
				</span>
				<span
					className="a-text-3"
					style={{
						fontFamily: fonts.mono,
						fontSize: "8px",
						letterSpacing: "0.26em",
						textTransform: "uppercase",
						color: colors.textTertiary,
						verticalAlign: "middle",
						marginLeft: "6px",
					}}
				>
					Labs
				</span>
			</Section>

			<Section style={{ marginBottom: "18px" }}>
				{footLinks(statusUrl).map((link) => (
					<Link
						key={link.label}
						href={link.href}
						className="a-text-3"
						style={{
							fontFamily: fonts.mono,
							fontSize: "11px",
							letterSpacing: "0.06em",
							color: colors.textTertiary,
							marginRight: "18px",
							textDecoration: "none",
						}}
					>
						{link.label}
					</Link>
				))}
			</Section>

			<Text
				className="a-text-3"
				style={{
					fontFamily: fonts.sans,
					fontSize: "12px",
					lineHeight: "1.6",
					color: colors.textTertiary,
					margin: 0,
				}}
			>
				{legal}
			</Text>

			<Text
				className="a-text-3"
				style={{
					fontFamily: fonts.mono,
					fontSize: "10px",
					letterSpacing: "0.1em",
					textTransform: "uppercase",
					color: colors.textDisabled,
					margin: "14px 0 0",
				}}
			>
				© 2026 Alethia Labs · alethialabs.io
			</Text>
		</Section>
	);
}

/** Shared inline link style for the footer legal line. */
export const footerLegalLink = {
	color: colors.textSecondary,
	textDecoration: "underline",
	textUnderlineOffset: "2px",
} as const;
