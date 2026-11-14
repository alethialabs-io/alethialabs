// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReportWindow } from "../dates";
import { fetchJson, isRecord, num } from "../exec";
import type { CloudResult, LineItem } from "../types";

/**
 * GCP spend, read through the Cloud Billing BUDGET plane, because that is what the e2e stack has.
 *
 * The Budget API returns a budget's configured AMOUNT and never its spend. Spend arrives only in the
 * budget's programmatic notifications on Pub/Sub — `costAmount`, month to date, several times a day
 * (infra/gcp-e2e/e2e-budget.tf publishes them to `alethia-e2e-nightly-budget-alerts`). The report
 * reads its own subscription on that topic (infra/gcp-e2e/spend-reporter.tf) WITHOUT acknowledging,
 * so the last seven days of notifications are there each week, and:
 *
 *   mtd    = the latest notification's costAmount for the current month
 *   last7  ≈ latest costAmount − the earliest one at or after the window start, within one month;
 *            across a month boundary, the previous month's last reading minus its earliest in the
 *            window is added. Labelled approximate, because notifications are periodic samples.
 *
 * Whether the billing account is OPEN is read separately and stated plainly — a closed account stops
 * accruing, which is a fact the reader needs, not an error.
 */

/** One decoded budget notification. */
export interface BudgetNotification {
	budgetDisplayName: string;
	costAmount: number;
	budgetAmount: number | null;
	currencyCode: string;
	/** Month the costAmount accumulates over, `YYYY-MM-DD` of its start. */
	costIntervalStart: string;
	publishTime: string;
}

/** Decodes Pub/Sub `receivedMessages` into budget notifications, skipping anything unreadable. */
export function decodeBudgetMessages(received: unknown[]): BudgetNotification[] {
	const out: BudgetNotification[] = [];
	const seen = new Set<string>();
	for (const r of received) {
		if (!isRecord(r) || !isRecord(r.message)) continue;
		const m = r.message;
		const id = typeof m.messageId === "string" ? m.messageId : "";
		if (id && seen.has(id)) continue;
		if (id) seen.add(id);
		if (typeof m.data !== "string" || typeof m.publishTime !== "string") continue;
		let d: unknown;
		try {
			d = JSON.parse(Buffer.from(m.data, "base64").toString("utf8"));
		} catch {
			continue;
		}
		if (!isRecord(d)) continue;
		const cost = num(d.costAmount);
		if (cost === null || typeof d.currencyCode !== "string" || typeof d.costIntervalStart !== "string") continue;
		out.push({
			budgetDisplayName: typeof d.budgetDisplayName === "string" ? d.budgetDisplayName : "budget",
			costAmount: cost,
			budgetAmount: num(d.budgetAmount),
			currencyCode: d.currencyCode,
			costIntervalStart: d.costIntervalStart.slice(0, 10),
			publishTime: m.publishTime,
		});
	}
	return out;
}

/** What the notifications say, per budget and in total. */
export interface BudgetSpend {
	currency: string | null;
	mtd: number | null;
	last7Approx: number | null;
	perBudget: LineItem[];
	/** The newest notification's publish time, so a stale feed is visible. */
	latestAt: string | null;
}

/** Spend over the window for one budget's notifications (see the file header for the arithmetic). */
function budgetWindowSpend(ns: BudgetNotification[], w: ReportWindow): { mtd: number | null; last7: number | null } {
	const sorted = [...ns].sort((a, b) => a.publishTime.localeCompare(b.publishTime));
	const inWindow = sorted.filter((n) => n.publishTime.slice(0, 10) >= w.last7Start);
	const current = sorted.filter((n) => n.costIntervalStart === w.monthStart);
	const mtd = current.length > 0 ? (current[current.length - 1]?.costAmount ?? null) : null;
	if (inWindow.length < 2) return { mtd, last7: null };
	let last7 = 0;
	const byMonth = new Map<string, BudgetNotification[]>();
	for (const n of inWindow) byMonth.set(n.costIntervalStart, [...(byMonth.get(n.costIntervalStart) ?? []), n]);
	for (const [month, list] of byMonth) {
		const first = list[0];
		const lastN = list[list.length - 1];
		if (!first || !lastN) continue;
		// The month the window OPENED in started before the window, so its first in-window reading is
		// the baseline. A month that began inside the window started from zero.
		const baseline = month < w.last7Start ? first.costAmount : 0;
		last7 += lastN.costAmount - baseline;
	}
	return { mtd, last7 };
}

/** Folds every budget's notifications into totals. Mixed currencies are refused rather than summed. */
export function summariseBudgets(ns: BudgetNotification[], w: ReportWindow): BudgetSpend {
	const byBudget = new Map<string, BudgetNotification[]>();
	for (const n of ns) byBudget.set(n.budgetDisplayName, [...(byBudget.get(n.budgetDisplayName) ?? []), n]);
	const currencies = new Set(ns.map((n) => n.currencyCode));
	if (currencies.size > 1) throw new Error(`budget notifications use more than one currency (${[...currencies].join(", ")})`);
	let mtd: number | null = null;
	let last7: number | null = null;
	const perBudget: LineItem[] = [];
	for (const [name, list] of byBudget) {
		const s = budgetWindowSpend(list, w);
		if (s.mtd !== null) {
			mtd = (mtd ?? 0) + s.mtd;
			perBudget.push({ label: `${name} (month to date)`, amount: s.mtd });
		}
		if (s.last7 !== null) last7 = (last7 ?? 0) + s.last7;
	}
	const latestAt = ns.reduce<string | null>((a, n) => (a === null || n.publishTime > a ? n.publishTime : a), null);
	return { currency: [...currencies][0] ?? null, mtd, last7Approx: last7, perBudget, latestAt };
}

/** Configuration for the GCP read; every field is a repo variable. */
export interface GcpConfig {
	billingAccount: string;
	/** `projects/<p>/subscriptions/<s>`. */
	subscription: string;
}

/** Reads GCP. Never throws. */
export async function readGcp(
	w: ReportWindow,
	cfg: GcpConfig,
	accessToken: string | undefined,
	credentialsReason: string,
): Promise<CloudResult> {
	if (!accessToken) return { cloud: "gcp", status: "unreadable", reason: credentialsReason };
	if (!cfg.billingAccount) return { cloud: "gcp", status: "unreadable", reason: "SPEND_GCP_BILLING_ACCOUNT is unset" };
	const auth = { authorization: `Bearer ${accessToken}` };
	const notes: string[] = [];
	try {
		const acct = await fetchJson(`https://cloudbilling.googleapis.com/v1/billingAccounts/${cfg.billingAccount}`, { headers: auth });
		if (isRecord(acct) && acct.open === false) {
			notes.push(`Billing account ${cfg.billingAccount} is CLOSED — nothing new accrues on it; any figure below is what was billed before it closed.`);
		}
	} catch (err) {
		notes.push(`Billing account state not readable — ${err instanceof Error ? err.message : String(err)}`);
	}

	const budgetLines: string[] = [];
	try {
		const b = await fetchJson(`https://billingbudgets.googleapis.com/v1/billingAccounts/${cfg.billingAccount}/budgets`, { headers: auth });
		for (const x of isRecord(b) && Array.isArray(b.budgets) ? b.budgets : []) {
			if (!isRecord(x)) continue;
			const sa = isRecord(x.amount) && isRecord(x.amount.specifiedAmount) ? x.amount.specifiedAmount : null;
			const units = sa ? (num(sa.units) ?? 0) + (num(sa.nanos) ?? 0) / 1e9 : null;
			budgetLines.push(`${typeof x.displayName === "string" ? x.displayName : "budget"}: ${units === null ? "last period's spend" : `${units} ${sa && typeof sa.currencyCode === "string" ? sa.currencyCode : ""}`.trim()} / month`);
		}
		if (budgetLines.length > 0) notes.push(`Budgets: ${budgetLines.join("; ")}.`);
	} catch (err) {
		notes.push(`Budgets not readable — ${err instanceof Error ? err.message : String(err)}`);
	}

	if (!cfg.subscription) {
		return { cloud: "gcp", status: "unreadable", reason: `SPEND_GCP_BUDGET_SUBSCRIPTION is unset, so no spend figure is available (the Budget API holds amounts, not spend). ${notes.join(" ")}`.trim() };
	}
	try {
		const received: unknown[] = [];
		for (let i = 0; i < 10; i++) {
			const page = await fetchJson(`https://pubsub.googleapis.com/v1/${cfg.subscription}:pull`, {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ maxMessages: 1000 }),
			});
			const msgs = isRecord(page) && Array.isArray(page.receivedMessages) ? page.receivedMessages : [];
			if (msgs.length === 0) break;
			received.push(...msgs);
		}
		// Hand every lease straight back (deadline 0) instead of acknowledging: the messages stay for
		// next week's window and for a re-dispatch ten minutes from now. Best-effort — a failed release
		// only delays redelivery until the 600s ack deadline.
		const ackIds = received.flatMap((r) => (isRecord(r) && typeof r.ackId === "string" ? [r.ackId] : []));
		for (let i = 0; i < ackIds.length; i += 1000) {
			await fetchJson(`https://pubsub.googleapis.com/v1/${cfg.subscription}:modifyAckDeadline`, {
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ ackIds: ackIds.slice(i, i + 1000), ackDeadlineSeconds: 0 }),
			}).catch(() => undefined);
		}
		const ns = decodeBudgetMessages(received);
		if (ns.length === 0) {
			return {
				cloud: "gcp",
				status: "unreadable",
				reason: `no budget notification in the last 7 days on ${cfg.subscription} — the budget is not publishing (or the account is closed). ${notes.join(" ")}`.trim(),
			};
		}
		const s = summariseBudgets(ns, w);
		if (s.latestAt) notes.push(`Latest budget notification: ${s.latestAt}.`);
		if (s.last7Approx !== null) notes.push("7-day figure is approximate: the difference between periodic budget notifications.");
		return {
			cloud: "gcp",
			status: "ok",
			currency: s.currency ?? "USD",
			last7: s.last7Approx,
			prior7: null,
			mtd: s.mtd,
			estimate: false,
			lineItemBasis: "mtd",
			lineItems: s.perBudget,
			breakdowns: [],
			notes,
		};
	} catch (err) {
		return { cloud: "gcp", status: "unreadable", reason: `${err instanceof Error ? err.message : String(err)} ${notes.join(" ")}`.trim() };
	}
}
