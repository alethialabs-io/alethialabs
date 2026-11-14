// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { bucketDaily, type DailyRow } from "../aggregate";
import { normaliseDay, type ReportWindow } from "../dates";
import { fetchJson, isRecord, num, run } from "../exec";
import type { CloudResult } from "../types";

/**
 * Azure spend from the Cost Management query API, scoped to the e2e subscription and read as the
 * `spend-reporter` application (Cost Management Reader only — infra/azure-e2e/spend-reporter.tf).
 * The token comes from the `az` session azure/login left behind.
 */
const API_VERSION = "2023-11-01";

/**
 * Parses one Cost Management query response page into daily rows. The API returns a column list and
 * positional rows, and the column NAMES differ by cost type (`Cost` vs `PreTaxCost`), so every index
 * is looked up by name rather than assumed.
 */
export function parseAzureQuery(page: unknown): { rows: DailyRow[]; currency: string | null; nextLink: string | null } {
	if (!isRecord(page) || !isRecord(page.properties)) throw new Error("Cost Management response has no properties");
	const p = page.properties;
	const cols = Array.isArray(p.columns) ? p.columns.map((c) => (isRecord(c) && typeof c.name === "string" ? c.name : "")) : [];
	const idx = (...names: string[]) => cols.findIndex((c) => names.includes(c));
	const iCost = idx("Cost", "PreTaxCost", "CostUSD");
	const iDate = idx("UsageDate", "BillingMonth");
	const iKey = idx("ServiceName", "MeterCategory", "ResourceGroupName");
	const iCur = idx("Currency", "BillingCurrency");
	if (iCost === -1 || iDate === -1) throw new Error(`Cost Management response is missing cost/date columns (got ${cols.join(", ")})`);
	const rows: DailyRow[] = [];
	let currency: string | null = null;
	for (const raw of Array.isArray(p.rows) ? p.rows : []) {
		if (!Array.isArray(raw)) continue;
		const amount = num(raw[iCost]);
		const date = normaliseDay(raw[iDate] as string | number);
		if (amount === null || date === null) continue;
		const cur = iCur === -1 ? null : String(raw[iCur] ?? "");
		if (cur) {
			if (currency !== null && cur !== currency) throw new Error(`Cost Management returned two currencies (${currency}, ${cur})`);
			currency = cur;
		}
		rows.push({ date, key: iKey === -1 ? "Azure" : String(raw[iKey] ?? "?"), amount });
	}
	return { rows, currency, nextLink: typeof p.nextLink === "string" && p.nextLink !== "" ? p.nextLink : null };
}

/** The query body: actual cost, daily, grouped by service, over [from, to]. */
export function azureQueryBody(w: ReportWindow): unknown {
	return {
		type: "ActualCost",
		timeframe: "Custom",
		// The API's `to` is INCLUSIVE, unlike CE's End — so it is the last complete day.
		timePeriod: { from: `${w.queryStart}T00:00:00Z`, to: `${w.weekEnding}T23:59:59Z` },
		dataset: {
			granularity: "Daily",
			aggregation: { totalCost: { name: "Cost", function: "Sum" } },
			grouping: [{ type: "Dimension", name: "ServiceName" }],
		},
	};
}

/** Reads Azure spend. Never throws. */
export async function readAzure(
	w: ReportWindow,
	subscriptionId: string,
	credentialsReady: boolean,
	credentialsReason: string,
): Promise<CloudResult> {
	if (!credentialsReady) return { cloud: "azure", status: "unreadable", reason: credentialsReason };
	try {
		const token = (await run("az", ["account", "get-access-token", "--resource", "https://management.azure.com/", "--query", "accessToken", "-o", "tsv"])).trim();
		if (!token) throw new Error("az returned an empty access token");
		let url: string | null = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${API_VERSION}`;
		const rows: DailyRow[] = [];
		let currency: string | null = null;
		for (let i = 0; i < 10 && url; i++) {
			const page = await fetchJson(url, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify(azureQueryBody(w)),
			});
			const parsed = parseAzureQuery(page);
			rows.push(...parsed.rows);
			currency = currency ?? parsed.currency;
			url = parsed.nextLink;
		}
		const b = bucketDaily(rows, w);
		return {
			cloud: "azure",
			status: "ok",
			currency: currency ?? "USD",
			last7: b.last7,
			prior7: b.prior7,
			mtd: b.mtd,
			estimate: false,
			lineItemBasis: "7d",
			lineItems: b.byKeyLast7,
			breakdowns: [],
			notes: rows.length === 0 ? ["No cost rows in the window (an idle subscription reports nothing, not zero)."] : [],
		};
	} catch (err) {
		return { cloud: "azure", status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
	}
}
