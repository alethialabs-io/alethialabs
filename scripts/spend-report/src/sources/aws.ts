// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { bucketDaily, sortItems, type DailyRow } from "../aggregate";
import { normaliseDay, type ReportWindow } from "../dates";
import { isRecord, num, runJson } from "../exec";
import { awsLeaksFromMappings } from "../leaks";
import type { Breakdown, CloudResult, LeakResult, LineItem } from "../types";

/**
 * AWS spend from Cost Explorer `GetCostAndUsage`, through the `aws` CLI on the runner (credentials
 * come from aws-actions/configure-aws-credentials assuming `alethia-spend-reporter`).
 *
 * Calls, each billed by AWS at USD 0.01: one DAILY query grouped by SERVICE spanning every window,
 * one per `alethia:*` tag key over the last seven days, and — only with `groupByLinkedAccount` — one
 * grouped by LINKED_ACCOUNT. With the defaults that is four requests a week.
 */
export interface AwsConfig {
	/** Cost-allocation tag keys to break the last 7 days down by. */
	tagKeys: string[];
	/**
	 * Also group by LINKED_ACCOUNT. Meaningful only on an Organization's PAYER account, where Cost
	 * Explorer sees every member; on a standalone account it returns one group. Off by default.
	 */
	groupByLinkedAccount: boolean;
	/** Regions the e2e leak scan reads; the tagging API is regional. */
	leakRegions: string[];
}

/** The tag keys the infra stamps on every resource (packages/core/cloud/tags.go via classification_tags). */
export const DEFAULT_AWS_TAG_KEYS = ["alethia:project-id", "alethia:environment-id", "alethia:e2e-run"];

/** A CE group key may be a tag rendered `key$value`; this turns it into the value, or a placeholder. */
export function ceGroupLabel(key: string): string {
	const i = key.indexOf("$");
	if (i === -1) return key;
	const value = key.slice(i + 1);
	return value === "" ? "(untagged)" : value;
}

/**
 * Flattens `GetCostAndUsage` pages into daily rows. Each group's first key is the row key; a result
 * with no groups (a period with no spend) contributes nothing. The unit is checked so a mixed-currency
 * response cannot be summed as one number.
 */
export function parseCeResults(pages: unknown[]): { rows: DailyRow[]; currency: string | null; estimated: boolean } {
	const rows: DailyRow[] = [];
	let currency: string | null = null;
	let estimated = false;
	for (const page of pages) {
		if (!isRecord(page) || !Array.isArray(page.ResultsByTime)) continue;
		for (const r of page.ResultsByTime) {
			if (!isRecord(r)) continue;
			if (r.Estimated === true) estimated = true;
			const start = isRecord(r.TimePeriod) && typeof r.TimePeriod.Start === "string" ? normaliseDay(r.TimePeriod.Start) : null;
			if (!start || !Array.isArray(r.Groups)) continue;
			for (const g of r.Groups) {
				if (!isRecord(g) || !Array.isArray(g.Keys) || !isRecord(g.Metrics)) continue;
				const metric = g.Metrics.UnblendedCost;
				if (!isRecord(metric)) continue;
				const amount = num(metric.Amount);
				const unit = typeof metric.Unit === "string" ? metric.Unit : null;
				if (amount === null || unit === null) continue;
				if (currency !== null && unit !== currency) {
					throw new Error(`Cost Explorer returned two currencies (${currency}, ${unit}) in one query`);
				}
				currency = unit;
				rows.push({ date: start, key: String(g.Keys[0] ?? "?"), amount });
			}
		}
	}
	return { rows, currency, estimated };
}

/** Sums daily rows per CE group label over the last seven days. */
function last7ByLabel(rows: DailyRow[], w: ReportWindow): LineItem[] {
	const m = new Map<string, number>();
	for (const r of rows) {
		if (r.date < w.last7Start || r.date >= w.today) continue;
		const label = ceGroupLabel(r.key);
		m.set(label, (m.get(label) ?? 0) + r.amount);
	}
	return sortItems([...m].map(([label, amount]) => ({ label, amount })));
}

/** Runs one paginated GetCostAndUsage. */
async function getCostAndUsage(start: string, end: string, groupBy: string): Promise<unknown[]> {
	const pages: unknown[] = [];
	let token: string | undefined;
	for (let i = 0; i < 20; i++) {
		const args = [
			"ce",
			"get-cost-and-usage",
			"--time-period",
			`Start=${start},End=${end}`,
			"--granularity",
			"DAILY",
			"--metrics",
			"UnblendedCost",
			"--group-by",
			groupBy,
			"--output",
			"json",
		];
		if (token) args.push("--next-page-token", token);
		const page = await runJson("aws", args);
		pages.push(page);
		token = isRecord(page) && typeof page.NextPageToken === "string" ? page.NextPageToken : undefined;
		if (!token) break;
	}
	return pages;
}

/** Reads AWS spend. Never throws: a failure is returned as `unreadable` with the reason. */
export async function readAws(w: ReportWindow, cfg: AwsConfig, credentialsReady: boolean, credentialsReason: string): Promise<CloudResult> {
	if (!credentialsReady) return { cloud: "aws", status: "unreadable", reason: credentialsReason };
	try {
		const svc = parseCeResults(await getCostAndUsage(w.queryStart, w.today, "Type=DIMENSION,Key=SERVICE"));
		const b = bucketDaily(svc.rows, w);
		const currency = svc.currency ?? "USD";
		const notes: string[] = [];
		if (svc.estimated) notes.push("Cost Explorer marks part of this period as estimated (the most recent ~24h settle later).");

		const breakdowns: Breakdown[] = [];
		for (const key of cfg.tagKeys) {
			try {
				const t = parseCeResults(await getCostAndUsage(w.last7Start, w.today, `Type=TAG,Key=${key}`));
				const items = last7ByLabel(t.rows, w);
				if (items.length === 1 && items[0]?.label === "(untagged)") {
					notes.push(`Tag ${key}: every cost is untagged — it is probably not activated as a cost-allocation tag (Billing → Cost allocation tags).`);
				}
				breakdowns.push({ title: `Last 7 days by ${key}`, items: items.slice(0, 10) });
			} catch (err) {
				notes.push(`Tag ${key} breakdown not readable — ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (cfg.groupByLinkedAccount) {
			try {
				const la = parseCeResults(await getCostAndUsage(w.last7Start, w.today, "Type=DIMENSION,Key=LINKED_ACCOUNT"));
				breakdowns.push({ title: "Last 7 days by linked account", items: last7ByLabel(la.rows, w) });
			} catch (err) {
				notes.push(`Linked-account breakdown not readable — ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return {
			cloud: "aws",
			status: "ok",
			currency,
			last7: b.last7,
			prior7: b.prior7,
			mtd: b.mtd,
			estimate: false,
			lineItemBasis: "7d",
			lineItems: b.byKeyLast7,
			breakdowns,
			notes,
		};
	} catch (err) {
		return { cloud: "aws", status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
	}
}

/** The e2e leak scan: every live resource carrying an e2e handle, in each configured region. */
export async function scanAwsLeaks(cfg: AwsConfig, credentialsReady: boolean, credentialsReason: string): Promise<LeakResult> {
	if (!credentialsReady) return { cloud: "aws", status: "unreadable", reason: credentialsReason };
	try {
		const mappings: unknown[] = [];
		for (const region of cfg.leakRegions) {
			for (const key of ["alethia:project-id", "alethia:e2e-run"]) {
				// The CLI paginates get-resources itself.
				const out = await runJson("aws", [
					"resourcegroupstaggingapi",
					"get-resources",
					"--region",
					region,
					"--tag-filters",
					`Key=${key}`,
					"--output",
					"json",
				]);
				if (isRecord(out) && Array.isArray(out.ResourceTagMappingList)) mappings.push(...out.ResourceTagMappingList);
			}
		}
		return {
			cloud: "aws",
			status: "ok",
			leaks: awsLeaksFromMappings(mappings.filter(isRecord)),
			scope: `tagging API in ${cfg.leakRegions.join(", ")}`,
		};
	} catch (err) {
		return { cloud: "aws", status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Reads the prod vault (`alethia/prod/env`) and returns the keys the email send needs. The value is
 * returned, never printed; the caller masks it before anything is logged.
 */
export async function readVault(secretId: string, region: string): Promise<Record<string, string>> {
	const out = await runJson("aws", ["secretsmanager", "get-secret-value", "--secret-id", secretId, "--region", region, "--output", "json"]);
	if (!isRecord(out) || typeof out.SecretString !== "string") throw new Error(`${secretId} has no SecretString`);
	const blob: unknown = JSON.parse(out.SecretString);
	if (!isRecord(blob)) throw new Error(`${secretId} is not a JSON object`);
	const keys: Record<string, string> = {};
	for (const k of ["RESEND_API_KEY", "EMAIL_FROM", "AUTH_EMAIL_FROM"]) {
		const v = blob[k];
		if (typeof v === "string" && v !== "") keys[k] = v;
	}
	return keys;
}
