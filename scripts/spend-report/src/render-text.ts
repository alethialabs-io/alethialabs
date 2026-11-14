// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Delta, Report, ReportRow, TopItem } from "./aggregate";
import { groupLeaks } from "./leaks";
import { CLOUD_LABEL } from "./types";

/** Formats an amount with its ISO currency code, two decimals: `EUR 12.30`. Null reads as `n/a`. */
export function fmtMoney(amount: number | null, currency: string): string {
	if (amount === null) return "n/a";
	const sign = amount < 0 ? "-" : "";
	return `${sign}${currency} ${Math.abs(amount).toFixed(2)}`;
}

/** Formats a week-on-week delta: `+12% (+EUR 3.40)`, or `n/a`. */
export function fmtDelta(d: Delta | null, currency: string): string {
	if (!d) return "n/a";
	const abs = `${d.abs >= 0 ? "+" : "-"}${currency} ${Math.abs(d.abs).toFixed(2)}`;
	if (d.pct === null) return `${abs} (no prior spend)`;
	return `${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(0)}% (${abs})`;
}

/** Labels a line item's basis for a reader. */
export function basisLabel(basis: TopItem["basis"]): string {
	return basis === "7d" ? "7 days" : basis === "mtd" ? "month to date" : "est. 7 days";
}

/** The one-line headline a cloud gets, readable or not. */
export function cloudLine(r: ReportRow): string {
	if (r.status === "unreadable") return `${r.label}: not readable — ${r.reason ?? "unknown reason"}`;
	const cur = r.currency ?? "?";
	const est = r.estimate ? " (estimate)" : "";
	const native = cur === "EUR" ? "" : ` [${fmtMoney(r.last7, cur)}]`;
	const mtd = r.mtd === null ? "" : ` · MTD ${fmtMoney(r.mtdEur, "EUR")}${cur === "EUR" ? "" : ` [${fmtMoney(r.mtd, cur)}]`}`;
	return `${r.label}${est}: 7d ${fmtMoney(r.last7Eur, "EUR")}${native} · WoW ${fmtDelta(r.wow, cur)}${mtd}`;
}

/** The email subject. */
export function subjectLine(rep: Report): string {
	const wow = rep.totals.wow?.pct;
	const wowText = wow === null || wow === undefined ? "" : ` (${wow >= 0 ? "+" : ""}${wow.toFixed(0)}% WoW)`;
	const flags = rep.flags.length > 0 ? ` — ${rep.flags.length} flag${rep.flags.length === 1 ? "" : "s"}` : "";
	// An unreadable cloud contributes nothing to the total, so the subject says how many there were —
	// otherwise a week where nothing could be read arrives as "EUR 0.00", which reads as good news.
	const unreadable = rep.rows.filter((r) => r.status === "unreadable").length;
	const gaps = unreadable > 0 ? ` — ${unreadable} of ${rep.rows.length} clouds not readable` : "";
	return `Cloud spend, week to ${rep.window.weekEnding}: ${fmtMoney(rep.totals.last7Eur, "EUR")}${wowText}${flags}${gaps}`;
}

/** Renders the whole report as plain text (the job summary and the run log). */
export function renderText(rep: Report): string {
	const out: string[] = [];
	out.push(subjectLine(rep), "");
	out.push(`Window: ${rep.window.last7Start} → ${rep.window.weekEnding} (7 complete UTC days); prior week ${rep.window.prior7Start} → ${rep.window.last7Start}; month to date from ${rep.window.monthStart}.`);
	if (rep.totals.excludedFromLast7.length > 0) {
		out.push(`The 7-day total leaves out: ${rep.totals.excludedFromLast7.map((c) => CLOUD_LABEL[c]).join(", ")} (no 7-day figure or no EUR rate).`);
	}
	if (rep.totals.includesEstimate) out.push("The 7-day total includes an estimate (Hetzner).");
	out.push("");
	if (rep.flags.length > 0) {
		out.push("RED FLAGS");
		for (const f of rep.flags) out.push(`  ! ${f}`);
		out.push("");
	}
	out.push("PER CLOUD");
	for (const r of rep.rows) {
		out.push(`  ${cloudLine(r)}`);
		for (const n of r.notes) out.push(`      - ${n}`);
		for (const b of r.breakdowns) {
			out.push(`      ${b.title}:`);
			for (const i of b.items) out.push(`        ${i.label}: ${fmtMoney(i.amountEur, "EUR")}`);
		}
	}
	out.push("", "TOP 10 LINE ITEMS");
	if (rep.top.length === 0) out.push("  (none)");
	rep.top.forEach((t, i) => {
		const native = t.currency === "EUR" ? "" : ` [${fmtMoney(t.amount, t.currency)}]`;
		out.push(`  ${String(i + 1).padStart(2)}. ${CLOUD_LABEL[t.cloud]} · ${t.label}: ${fmtMoney(t.amountEur, "EUR")}${native} (${basisLabel(t.basis)})`);
	});
	out.push("", "LEAK LIST (resources still carrying an e2e handle)");
	const groups = groupLeaks(rep.leaks);
	// "None found" only when something was actually LOOKED at — an all-unreadable scan is not a clean one.
	if (groups.length === 0) out.push(rep.leakScans.some((s) => s.status === "ok") ? "  none found in the scanned scopes" : "  NOT KNOWN — no cloud could be scanned");
	for (const g of groups) {
		out.push(`  ${CLOUD_LABEL[g.cloud]} · ${g.handle}: ${g.count} resource(s) — ${g.kinds.join(", ")}`);
		for (const id of g.ids.slice(0, 20)) out.push(`      ${id}`);
		if (g.ids.length > 20) out.push(`      … and ${g.ids.length - 20} more`);
	}
	for (const s of rep.leakScans) {
		out.push(`  scanned ${CLOUD_LABEL[s.cloud]}: ${s.status === "ok" ? s.detail : `NOT scanned — ${s.detail}`}`);
	}
	out.push("", `FX: ECB reference rates${rep.fx.date ? ` of ${rep.fx.date}` : " unavailable"}${rep.fx.missing.length > 0 ? `; no rate for ${rep.fx.missing.join(", ")}` : ""}.`);
	for (const w of rep.warnings) out.push(`Note: ${w}`);
	return out.join("\n");
}
