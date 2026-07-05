// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared pieces for the transactional billing emails (receipt, dunning, trial,
// cancellation, credit pack). Keeps the per-email templates focused on their copy
// while the legal footer + the key/value summary table stay in one place.

import { Link, Section, Text } from "@react-email/components";
import { footerLegalLink } from "@repo/email/components/footer";
import { colors, fonts, radii, text } from "@repo/email/components/theme";
import type { ReactNode } from "react";

/** Standard footer legal line for billing emails (receipt/invoice stream). */
export function BillingLegal(): ReactNode {
	return (
		<>
			You&apos;re receiving this because you manage billing for an Alethia
			organization. Manage{" "}
			<Link
				href="https://alethialabs.io/settings/billing"
				className="a-text-2"
				style={footerLegalLink}
			>
				billing
			</Link>{" "}
			·{" "}
			<Link
				href="https://alethialabs.io/privacy"
				className="a-text-2"
				style={footerLegalLink}
			>
				Privacy
			</Link>{" "}
			·{" "}
			<Link
				href="https://alethialabs.io/terms"
				className="a-text-2"
				style={footerLegalLink}
			>
				Terms
			</Link>
		</>
	);
}

export interface SummaryRow {
	label: string;
	value: ReactNode;
	/** Render as the emphasized total row (heavier, top-bordered). */
	strong?: boolean;
}

/**
 * A bordered key/value summary card — the amount/plan/period breakdown shown on
 * receipts and dunning emails. Grayscale, squared, mono values to match the system.
 */
export function SummaryTable({ rows }: { rows: SummaryRow[] }): ReactNode {
	return (
		<Section
			className="a-sunken a-border"
			style={{
				backgroundColor: colors.surfaceSunken,
				border: `1px solid ${colors.border}`,
				borderRadius: radii.md,
				padding: "6px 18px",
				margin: "4px 0 26px",
			}}
		>
			{rows.map((row, i) => (
				<Section
					key={row.label}
					className="a-border"
					style={{
						padding: "12px 0",
						borderTop:
							i === 0
								? undefined
								: `1px solid ${row.strong ? colors.borderStrong : colors.border}`,
					}}
				>
					<span
						className="a-text-3"
						style={{
							fontFamily: fonts.sans,
							fontSize: "13px",
							color: colors.textTertiary,
							display: "inline-block",
							width: "45%",
							verticalAlign: "top",
						}}
					>
						{row.label}
					</span>
					<span
						className={row.strong ? "a-text" : "a-text-2"}
						style={{
							fontFamily: fonts.mono,
							fontSize: row.strong ? "14px" : "13px",
							fontWeight: row.strong ? 600 : 400,
							color: row.strong ? colors.textPrimary : colors.textSecondary,
							display: "inline-block",
							width: "55%",
							textAlign: "right",
							verticalAlign: "top",
						}}
					>
						{row.value}
					</span>
				</Section>
			))}
		</Section>
	);
}

export interface FeatureRow {
	title: string;
	detail?: string;
}

/**
 * A ladder of title+detail rows with a marker in the gutter — the "what's included"
 * / "what happens next" list. Mirrors welcome.tsx's numbered-step device: a mono
 * marker (a number when `numbered`, else a ✓), a bold title, and a secondary detail,
 * each row divided by a hairline border.
 */
export function FeatureRows({
	rows = [],
	numbered = false,
}: {
	rows?: FeatureRow[];
	numbered?: boolean;
}): ReactNode {
	return (
		<Section style={{ margin: "4px 0 26px" }}>
			{rows.map((row, i) => (
				<Section
					key={row.title}
					className="a-border"
					style={{
						padding: "13px 0",
						borderTop: `1px solid ${colors.border}`,
						borderBottom:
							i === rows.length - 1 ? `1px solid ${colors.border}` : undefined,
					}}
				>
					<span
						className="a-text-3"
						style={{
							fontFamily: fonts.mono,
							fontSize: "11px",
							letterSpacing: numbered ? "0.1em" : "0",
							color: colors.textTertiary,
							marginRight: "14px",
							verticalAlign: "top",
						}}
					>
						{numbered ? String(i + 1).padStart(2, "0") : "✓"}
					</span>
					<span
						className="a-text-2"
						style={{
							fontFamily: fonts.sans,
							fontSize: "13.5px",
							lineHeight: "1.5",
							color: colors.textSecondary,
						}}
					>
						<strong
							className="a-text"
							style={{ color: colors.textPrimary, fontWeight: 500 }}
						>
							{row.title}
						</strong>
						{row.detail ? <> {row.detail}</> : null}
					</span>
				</Section>
			))}
		</Section>
	);
}

/**
 * A bordered sunken note box — a small mono label over a line of body copy. Used for
 * the "what happens next" / reassurance beat that gives the billing emails the same
 * narrative depth as welcome.tsx (intro → device → CTA).
 */
export function Callout({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}): ReactNode {
	return (
		<Section
			className="a-sunken a-border"
			style={{
				backgroundColor: colors.surfaceSunken,
				border: `1px solid ${colors.border}`,
				borderRadius: radii.md,
				padding: "14px 18px",
				margin: "4px 0 26px",
			}}
		>
			<Text
				className="a-text-3"
				style={{ ...text.eyebrow, margin: "0 0 6px" }}
			>
				{label}
			</Text>
			<Text
				className="a-text-2"
				style={{ ...text.body, fontSize: "13.5px", margin: 0 }}
			>
				{children}
			</Text>
		</Section>
	);
}
