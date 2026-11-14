// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { bucketDaily, sortItems, type DailyRow } from "../aggregate";
import { normaliseDay, type ReportWindow } from "../dates";
import { isRecord, num, runJson } from "../exec";
import { awsLeaksFromMappings } from "../leaks";
import type { Breakdown, CloudResult, LeakResult, LineItem } from "../types";

/**
 * AWS spend from Cost Explorer `GetCostAndUsage`, through the `aws` CLI on the runner, for EVERY
 * account the report is given credentials to. A member account's Cost Explorer sees only that
 * account's spend, so the dedicated `alethia-e2e` account is read through its own reporter role and
 * the two readings are summed into the one AWS row (`combineAwsAccounts`).
 *
 * Calls, each billed by AWS at USD 0.01, PER ACCOUNT: one DAILY query grouped by SERVICE spanning
 * every window, one per `alethia:*` tag key over the last seven days, and — only with
 * `groupByLinkedAccount` — one grouped by LINKED_ACCOUNT. With the defaults and two accounts that is
 * eight requests a week.
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

/**
 * One AWS account the report reads, and how its credentials arrived. The platform account's come
 * from the ambient environment (aws-actions/configure-aws-credentials' exported variables); every
 * other account's from a named CLI profile, because a second exported set would overwrite the first.
 */
export interface AwsAccount {
	/** The short name the report shows: `platform`, `e2e`. */
	name: string;
	/**
	 * The named CLI profile to pass as `--profile`, or undefined for the ambient credentials. The
	 * flag, not AWS_PROFILE: the CLI ranks exported key variables ABOVE AWS_PROFILE, so the env var
	 * would silently read the platform account twice; `--profile` outranks them.
	 */
	profile?: string;
	/** Whether this account's credential step succeeded. */
	ready: boolean;
	/** Why it did not, naming the fix. */
	reason: string;
}

/** One account's reading, before it is summed into the AWS row. */
export type AwsAccountResult =
	| {
			account: string;
			status: "ok";
			currency: string;
			last7: number;
			prior7: number;
			mtd: number | null;
			lineItems: LineItem[];
			breakdowns: Breakdown[];
			notes: string[];
	  }
	| { account: string; status: "unreadable"; reason: string };

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

/** Appends `--profile` for an account read through a named profile; the ambient account adds nothing. */
export function withProfile(args: string[], profile: string | undefined): string[] {
	return profile ? [...args, "--profile", profile] : args;
}

/** Runs one paginated GetCostAndUsage. */
async function getCostAndUsage(start: string, end: string, groupBy: string, profile: string | undefined): Promise<unknown[]> {
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
		const page = await runJson("aws", withProfile(args, profile));
		pages.push(page);
		token = isRecord(page) && typeof page.NextPageToken === "string" ? page.NextPageToken : undefined;
		if (!token) break;
	}
	return pages;
}

/** Reads ONE account's spend. Never throws: a failure is returned as `unreadable` with the reason. */
export async function readAwsAccount(w: ReportWindow, cfg: AwsConfig, account: AwsAccount): Promise<AwsAccountResult> {
	const { name, profile } = account;
	if (!account.ready) return { account: name, status: "unreadable", reason: account.reason };
	try {
		const svc = parseCeResults(await getCostAndUsage(w.queryStart, w.today, "Type=DIMENSION,Key=SERVICE", profile));
		const b = bucketDaily(svc.rows, w);
		const currency = svc.currency ?? "USD";
		const notes: string[] = [];
		if (svc.estimated) notes.push("Cost Explorer marks part of this period as estimated (the most recent ~24h settle later).");

		const breakdowns: Breakdown[] = [];
		for (const key of cfg.tagKeys) {
			try {
				const t = parseCeResults(await getCostAndUsage(w.last7Start, w.today, `Type=TAG,Key=${key}`, profile));
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
				const la = parseCeResults(await getCostAndUsage(w.last7Start, w.today, "Type=DIMENSION,Key=LINKED_ACCOUNT", profile));
				breakdowns.push({ title: "Last 7 days by linked account", items: last7ByLabel(la.rows, w) });
			} catch (err) {
				notes.push(`Linked-account breakdown not readable — ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		return {
			account: name,
			status: "ok",
			currency,
			last7: b.last7,
			prior7: b.prior7,
			mtd: b.mtd,
			lineItems: b.byKeyLast7,
			breakdowns,
			notes,
		};
	} catch (err) {
		return { account: name, status: "unreadable", reason: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Sums the per-account readings into the ONE AWS row the report shows. Pure.
 *
 * - Every readable account in the first readable account's currency is summed. MTD is unknown when
 *   any summed account's is (the 1st of the month), never a partial sum.
 * - With more than one account, each line item, breakdown and note is labelled with its account, and
 *   a "by account" breakdown shows the split.
 * - An account that could not be read — or whose currency cannot be added to the others — is left out
 *   of the figures and SAID to be, as the first note, so a partial AWS row cannot pass for a whole one.
 * - Only when NO account is readable is the AWS row itself unreadable, with every account's reason.
 */
export function combineAwsAccounts(results: AwsAccountResult[]): CloudResult {
	const multi = results.length > 1;
	const tag = (account: string, text: string) => (multi ? `${account}: ${text}` : text);
	const ok = results.flatMap((r) => (r.status === "ok" ? [r] : []));
	const first = ok[0];
	if (!first) {
		const reason = results.map((r) => (r.status === "unreadable" ? tag(r.account, r.reason) : "")).filter(Boolean).join("; ");
		return { cloud: "aws", status: "unreadable", reason: reason || "no AWS account was configured" };
	}
	const currency = first.currency;
	const summed = ok.filter((r) => r.currency === currency);
	const gaps: string[] = [];
	for (const r of results) {
		if (r.status === "unreadable") gaps.push(`${r.account} account not readable — ${r.reason}. The AWS figures leave it out.`);
		else if (r.currency !== currency) gaps.push(`${r.account} account reports in ${r.currency}, not ${currency}, so it is not added to the AWS figures.`);
	}

	const sum = (f: (r: (typeof summed)[number]) => number) => summed.reduce((a, r) => a + f(r), 0);
	const mtds = summed.map((r) => r.mtd);
	const breakdowns: Breakdown[] = [];
	if (multi) {
		breakdowns.push({
			title: "Last 7 days by account",
			items: sortItems(summed.map((r) => ({ label: r.account, amount: r.last7 }))),
		});
	}
	for (const r of summed) {
		for (const b of r.breakdowns) breakdowns.push(multi ? { title: `${b.title} (${r.account})`, items: b.items } : b);
	}
	return {
		cloud: "aws",
		status: "ok",
		currency,
		last7: sum((r) => r.last7),
		prior7: sum((r) => r.prior7),
		mtd: mtds.some((m) => m === null) ? null : mtds.reduce<number>((a, m) => a + (m ?? 0), 0),
		estimate: false,
		lineItemBasis: "7d",
		lineItems: sortItems(summed.flatMap((r) => r.lineItems.map((i) => ({ label: tag(r.account, i.label), amount: i.amount })))),
		breakdowns,
		notes: [...gaps, ...summed.flatMap((r) => r.notes.map((n) => tag(r.account, n)))],
	};
}

/** Reads AWS spend across every account, summed into one row. Never throws. */
export async function readAws(w: ReportWindow, cfg: AwsConfig, accounts: AwsAccount[]): Promise<CloudResult> {
	return combineAwsAccounts(await Promise.all(accounts.map((a) => readAwsAccount(w, cfg, a))));
}

/**
 * The e2e leak scan of one account: every live resource carrying an e2e handle, in each configured
 * region. `label` names the account in the scope or the reason when the report reads more than one.
 */
export async function scanAwsAccountLeaks(cfg: AwsConfig, account: AwsAccount, label: boolean): Promise<LeakResult> {
	const prefix = label ? `${account.name} account — ` : "";
	if (!account.ready) return { cloud: "aws", status: "unreadable", reason: `${prefix}${account.reason}` };
	try {
		const mappings: unknown[] = [];
		for (const region of cfg.leakRegions) {
			for (const key of ["alethia:project-id", "alethia:e2e-run"]) {
				// The CLI paginates get-resources itself.
				const out = await runJson(
					"aws",
					withProfile(["resourcegroupstaggingapi", "get-resources", "--region", region, "--tag-filters", `Key=${key}`, "--output", "json"], account.profile),
				);
				if (isRecord(out) && Array.isArray(out.ResourceTagMappingList)) mappings.push(...out.ResourceTagMappingList);
			}
		}
		return {
			cloud: "aws",
			status: "ok",
			leaks: awsLeaksFromMappings(mappings.filter(isRecord)),
			scope: `${prefix}tagging API in ${cfg.leakRegions.join(", ")}`,
		};
	} catch (err) {
		return { cloud: "aws", status: "unreadable", reason: `${prefix}${err instanceof Error ? err.message : String(err)}` };
	}
}

/** The leak scan of every account, one result each, so an unscanned account is named, not hidden. */
export function scanAwsLeaks(cfg: AwsConfig, accounts: AwsAccount[]): Promise<LeakResult[]> {
	return Promise.all(accounts.map((a) => scanAwsAccountLeaks(cfg, a, accounts.length > 1)));
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
