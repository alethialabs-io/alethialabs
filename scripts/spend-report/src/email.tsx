// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, Section, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { colors, fonts, text } from "@repo/email/components/theme";
import type { CSSProperties } from "react";
import type { Report } from "./aggregate";
import { groupLeaks } from "./leaks";
import { basisLabel, cloudLine, fmtDelta, fmtMoney, subjectLine } from "./render-text";
import { CLOUD_LABEL } from "./types";

const cell: CSSProperties = {
	fontFamily: fonts.sans,
	fontSize: "13px",
	color: colors.textPrimary,
	padding: "6px 8px",
	borderBottom: `1px solid ${colors.border}`,
	textAlign: "left",
	verticalAlign: "top",
};
const num: CSSProperties = { ...cell, textAlign: "right", fontFamily: fonts.mono, whiteSpace: "nowrap" };
const head: CSSProperties = { ...cell, color: colors.textTertiary, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.08em" };
const small: CSSProperties = { ...text.body, fontSize: "12.5px", margin: "4px 0 0" };
const flag: CSSProperties = { ...text.body, color: colors.textPrimary, fontWeight: 600, margin: "0 0 6px" };

/** Section heading inside the report. */
function H({ children }: { children: string }) {
	return (
		<Heading as="h2" style={{ ...text.eyebrow, margin: "28px 0 10px" }}>
			{children}
		</Heading>
	);
}

/** The weekly spend report email. Every figure is precomputed in `report`; this only lays it out. */
export function SpendReportEmail({ report }: { report: Report }) {
	const rep = report;
	const leakGroups = groupLeaks(rep.leaks);
	return (
		<EmailLayout preview={subjectLine(rep)} legal="Sent weekly by spend-report.yml to the address in SPEND_REPORT_TO.">
			<Text style={text.eyebrow}>Weekly cloud spend · week to {rep.window.weekEnding}</Text>
			<Heading as="h1" style={text.heading}>
				{fmtMoney(rep.totals.last7Eur, "EUR")} in 7 days
			</Heading>
			<Text style={text.body}>
				Week on week: {fmtDelta(rep.totals.wow, "EUR")} · month to date {fmtMoney(rep.totals.mtdEur, "EUR")}.
				{rep.totals.excludedFromLast7.length > 0
					? ` Leaves out ${rep.totals.excludedFromLast7.map((c) => CLOUD_LABEL[c]).join(", ")} (no 7-day figure).`
					: ""}
				{rep.totals.includesEstimate ? " Includes the Hetzner estimate." : ""}
			</Text>

			{rep.flags.length > 0 ? (
				<Section style={{ border: `2px solid ${colors.ink}`, padding: "12px 14px", margin: "8px 0 0" }}>
					<Text style={{ ...text.eyebrow, margin: "0 0 8px" }}>Red flags</Text>
					{rep.flags.map((f) => (
						<Text key={f} style={flag}>
							{f}
						</Text>
					))}
				</Section>
			) : null}

			<H>Per cloud</H>
			<table width="100%" cellPadding={0} cellSpacing={0} style={{ borderCollapse: "collapse" }}>
				<thead>
					<tr>
						<th style={head}>Cloud</th>
						<th style={{ ...head, textAlign: "right" }}>7 days (EUR)</th>
						<th style={{ ...head, textAlign: "right" }}>Native</th>
						<th style={{ ...head, textAlign: "right" }}>WoW</th>
						<th style={{ ...head, textAlign: "right" }}>MTD (EUR)</th>
					</tr>
				</thead>
				<tbody>
					{rep.rows.map((r) =>
						r.status === "unreadable" ? (
							<tr key={r.cloud}>
								<td style={cell}>{r.label}</td>
								<td style={cell} colSpan={4}>
									not readable — {r.reason}
								</td>
							</tr>
						) : (
							<tr key={r.cloud}>
								<td style={cell}>
									{r.label}
									{r.estimate ? " (estimate)" : ""}
									{r.flagged ? " — over threshold" : ""}
								</td>
								<td style={num}>{fmtMoney(r.last7Eur, "EUR")}</td>
								<td style={num}>{fmtMoney(r.last7, r.currency ?? "?")}</td>
								<td style={num}>{fmtDelta(r.wow, r.currency ?? "?")}</td>
								<td style={num}>{fmtMoney(r.mtdEur, "EUR")}</td>
							</tr>
						),
					)}
				</tbody>
			</table>
			{rep.rows
				.filter((r) => r.status === "ok" && (r.notes.length > 0 || r.breakdowns.length > 0))
				.map((r) => (
					<Section key={`n-${r.cloud}`} style={{ margin: "10px 0 0" }}>
						<Text style={{ ...small, color: colors.textPrimary, fontWeight: 600 }}>{r.label}</Text>
						{r.notes.map((n) => (
							<Text key={n} style={small}>
								{n}
							</Text>
						))}
						{r.breakdowns.map((b) => (
							<Text key={b.title} style={small}>
								{b.title}: {b.items.length === 0 ? "nothing" : b.items.map((i) => `${i.label} ${fmtMoney(i.amountEur, "EUR")}`).join(" · ")}
							</Text>
						))}
					</Section>
				))}

			<H>Top 10 line items</H>
			{rep.top.length === 0 ? (
				<Text style={text.body}>No priced line items.</Text>
			) : (
				<table width="100%" cellPadding={0} cellSpacing={0} style={{ borderCollapse: "collapse" }}>
					<tbody>
						{rep.top.map((t, i) => (
							<tr key={`${t.cloud}-${t.label}`}>
								<td style={{ ...num, textAlign: "left", width: "24px" }}>{i + 1}</td>
								<td style={cell}>
									{CLOUD_LABEL[t.cloud]} · {t.label}
									<span style={{ color: colors.textTertiary }}> ({basisLabel(t.basis)})</span>
								</td>
								<td style={num}>{fmtMoney(t.amountEur, "EUR")}</td>
								<td style={num}>{t.currency === "EUR" ? "" : fmtMoney(t.amount, t.currency)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			<H>Leak list</H>
			{leakGroups.length === 0 ? (
				<Text style={text.body}>
					{rep.leakScans.some((s) => s.status === "ok")
						? "No resource still carries an e2e handle in the scanned scopes."
						: "Not known — no cloud could be scanned this week."}
				</Text>
			) : (
				leakGroups.map((g) => (
					<Text key={`${g.cloud}-${g.handle}`} style={{ ...text.body, margin: "0 0 8px" }}>
						<strong>
							{CLOUD_LABEL[g.cloud]} · {g.handle}
						</strong>
						: {g.count} resource(s) — {g.kinds.join(", ")}
						<br />
						<span style={{ fontFamily: fonts.mono, fontSize: "11.5px" }}>
							{g.ids.slice(0, 20).join(" · ")}
							{g.ids.length > 20 ? ` … and ${g.ids.length - 20} more` : ""}
						</span>
					</Text>
				))
			)}
			{rep.leakScans.map((s) => (
				<Text key={`scan-${s.cloud}`} style={small}>
					{CLOUD_LABEL[s.cloud]}: {s.status === "ok" ? `scanned ${s.detail}` : `NOT scanned — ${s.detail}`}
				</Text>
			))}

			<H>How to read this</H>
			<Text style={small}>
				7 days = the last seven complete UTC days, {rep.window.last7Start} to {rep.window.weekEnding}. WoW compares them with the seven
				before. EUR via ECB reference rates{rep.fx.date ? ` of ${rep.fx.date}` : " (unavailable this week)"}
				{rep.fx.missing.length > 0 ? `; no rate for ${rep.fx.missing.join(", ")}` : ""}. Thresholds are EUR per 7 days per cloud
				(SPEND_REPORT_THRESHOLDS_EUR).
			</Text>
			{rep.warnings.map((w) => (
				<Text key={w} style={small}>
					Note: {w}
				</Text>
			))}
			{/* The plain lines, for a client that strips tables. */}
			<Text style={{ ...small, color: colors.textTertiary, marginTop: "20px" }}>{rep.rows.map(cloudLine).join(" | ")}</Text>
		</EmailLayout>
	);
}
