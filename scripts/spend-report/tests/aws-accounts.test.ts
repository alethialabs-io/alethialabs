// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The multi-account half of the AWS source: the platform account and the dedicated e2e account are
// read separately (a member account's Cost Explorer sees only itself) and summed into ONE AWS row.
// Everything here is pure, or takes the not-ready path that returns before any CLI call.

import { describe, expect, it } from "vitest";
import { buildReport, DEFAULT_THRESHOLDS } from "../src/aggregate";
import { reportWindow } from "../src/dates";
import { renderText } from "../src/render-text";
import {
	combineAwsAccounts,
	readAws,
	scanAwsLeaks,
	withProfile,
	type AwsAccountResult,
	type AwsConfig,
} from "../src/sources/aws";
import type { CloudReading, CloudResult } from "../src/types";

const w = reportWindow(new Date("2026-11-16T07:00:00Z"));
const cfg: AwsConfig = { tagKeys: [], groupByLinkedAccount: false, leakRegions: ["us-east-1"] };

const platform: AwsAccountResult = {
	account: "platform",
	status: "ok",
	currency: "USD",
	last7: 20,
	prior7: 18,
	mtd: 40,
	lineItems: [
		{ label: "Amazon Elastic Compute Cloud - Compute", amount: 12 },
		{ label: "Amazon Simple Email Service", amount: 8 },
	],
	breakdowns: [{ title: "Last 7 days by alethia:project-id", items: [{ label: "(untagged)", amount: 20 }] }],
	notes: ["Cost Explorer marks part of this period as estimated (the most recent ~24h settle later)."],
};

const e2e: AwsAccountResult = {
	account: "e2e",
	status: "ok",
	currency: "USD",
	last7: 15,
	prior7: 2,
	mtd: 17,
	lineItems: [{ label: "Amazon Elastic Container Service for Kubernetes", amount: 15 }],
	breakdowns: [{ title: "Last 7 days by alethia:project-id", items: [{ label: "e2e-123-1", amount: 15 }] }],
	notes: [],
};

/** Narrows a combined result to the readable shape, failing the test otherwise. */
function reading(r: CloudResult): CloudReading {
	if (r.status !== "ok") throw new Error(`expected a reading, got unreadable: ${r.reason}`);
	return r;
}

describe("combineAwsAccounts", () => {
	it("sums every window across the accounts into one AWS row", () => {
		const r = reading(combineAwsAccounts([platform, e2e]));
		expect(r).toMatchObject({ cloud: "aws", currency: "USD", last7: 35, prior7: 20, mtd: 57, estimate: false, lineItemBasis: "7d" });
	});

	it("shows the split per account, and labels every line, breakdown and note with its account", () => {
		const r = reading(combineAwsAccounts([platform, e2e]));
		expect(r.breakdowns[0]).toEqual({
			title: "Last 7 days by account",
			items: [
				{ label: "platform", amount: 20 },
				{ label: "e2e", amount: 15 },
			],
		});
		expect(r.breakdowns.slice(1).map((b) => b.title)).toEqual([
			"Last 7 days by alethia:project-id (platform)",
			"Last 7 days by alethia:project-id (e2e)",
		]);
		// Ranked across both accounts, not concatenated.
		expect(r.lineItems.map((i) => i.label)).toEqual([
			"e2e: Amazon Elastic Container Service for Kubernetes",
			"platform: Amazon Elastic Compute Cloud - Compute",
			"platform: Amazon Simple Email Service",
		]);
		expect(r.notes).toEqual(["platform: Cost Explorer marks part of this period as estimated (the most recent ~24h settle later)."]);
	});

	it("leaves out an unreadable account and SAYS so first, so a partial row cannot pass for a whole one", () => {
		const r = reading(
			combineAwsAccounts([platform, { account: "e2e", status: "unreadable", reason: "SPEND_REPORTER_E2E_ROLE_ARN is unset" }]),
		);
		expect(r).toMatchObject({ last7: 20, prior7: 18, mtd: 40 });
		expect(r.notes[0]).toBe("e2e account not readable — SPEND_REPORTER_E2E_ROLE_ARN is unset. The AWS figures leave it out.");
		expect(r.breakdowns[0]).toEqual({ title: "Last 7 days by account", items: [{ label: "platform", amount: 20 }] });
	});

	it("is unreadable only when no account is, carrying every account's reason", () => {
		expect(
			combineAwsAccounts([
				{ account: "platform", status: "unreadable", reason: "AccessDenied" },
				{ account: "e2e", status: "unreadable", reason: "SPEND_REPORTER_E2E_ROLE_ARN is unset" },
			]),
		).toEqual({ cloud: "aws", status: "unreadable", reason: "platform: AccessDenied; e2e: SPEND_REPORTER_E2E_ROLE_ARN is unset" });
	});

	it("does not add an account in another currency, and says why", () => {
		const r = reading(combineAwsAccounts([platform, { ...e2e, currency: "EUR" }]));
		expect(r.last7).toBe(20);
		expect(r.notes[0]).toBe("e2e account reports in EUR, not USD, so it is not added to the AWS figures.");
	});

	it("reports MTD as unknown when any summed account's is, never as a partial sum", () => {
		expect(reading(combineAwsAccounts([platform, { ...e2e, mtd: null }])).mtd).toBeNull();
	});

	it("keeps a single account's row exactly as it was before there were two", () => {
		const r = reading(combineAwsAccounts([platform]));
		expect(r.breakdowns).toEqual(platform.breakdowns);
		expect(r.lineItems.map((i) => i.label)).toEqual(["Amazon Elastic Compute Cloud - Compute", "Amazon Simple Email Service"]);
		expect(r.notes).toEqual(platform.notes);
		expect(combineAwsAccounts([{ account: "platform", status: "unreadable", reason: "AccessDenied" }])).toEqual({
			cloud: "aws",
			status: "unreadable",
			reason: "AccessDenied",
		});
	});
});

describe("withProfile", () => {
	it("passes --profile for a named-profile account and nothing for the ambient one", () => {
		expect(withProfile(["ce", "get-cost-and-usage"], "spend-e2e")).toEqual(["ce", "get-cost-and-usage", "--profile", "spend-e2e"]);
		expect(withProfile(["ce", "get-cost-and-usage"], undefined)).toEqual(["ce", "get-cost-and-usage"]);
	});
});

describe("accounts whose credentials did not arrive (no CLI call is made)", () => {
	const accounts = [
		{ name: "platform", ready: false, reason: "SPEND_REPORTER_ROLE_ARN is unset" },
		{ name: "e2e", profile: "spend-e2e", ready: false, reason: "SPEND_REPORTER_E2E_ROLE_ARN is unset" },
	];

	it("reads as one unreadable AWS row naming both", async () => {
		expect(await readAws(w, cfg, accounts)).toEqual({
			cloud: "aws",
			status: "unreadable",
			reason: "platform: SPEND_REPORTER_ROLE_ARN is unset; e2e: SPEND_REPORTER_E2E_ROLE_ARN is unset",
		});
	});

	it("scans each account separately, so an unscanned one is named rather than hidden", async () => {
		expect(await scanAwsLeaks(cfg, accounts)).toEqual([
			{ cloud: "aws", status: "unreadable", reason: "platform account — SPEND_REPORTER_ROLE_ARN is unset" },
			{ cloud: "aws", status: "unreadable", reason: "e2e account — SPEND_REPORTER_E2E_ROLE_ARN is unset" },
		]);
	});
});

describe("the two accounts in the report", () => {
	const fx = { date: "2026-11-13", rates: { EUR: 1, USD: 1.25 } };

	it("holds the SUMMED AWS figure to the AWS threshold, and lists both leak scans", () => {
		const report = buildReport({
			window: w,
			results: [combineAwsAccounts([platform, e2e])],
			leakResults: [
				{ cloud: "aws", status: "ok", leaks: [], scope: "platform account — tagging API in us-east-1" },
				{
					cloud: "aws",
					status: "ok",
					leaks: [{ cloud: "aws", id: "arn:aws:eks:us-east-1:556074788436:cluster/e2e-123-1", kind: "eks:cluster", handle: "e2e-123-1", key: "project-id" }],
					scope: "e2e account — tagging API in us-east-1",
				},
			],
			fx,
			thresholds: { ...DEFAULT_THRESHOLDS, aws: 25 },
			warnings: [],
		});
		const row = report.rows[0];
		// USD 35 / 1.25 = EUR 28, over 25 — though neither account alone (EUR 16, EUR 12) is.
		expect(row?.last7Eur).toBeCloseTo(28);
		expect(row?.flagged).toBe(true);
		expect(report.leaks).toHaveLength(1);
		const text = renderText(report);
		expect(text).toContain("scanned AWS: platform account — tagging API in us-east-1");
		expect(text).toContain("scanned AWS: e2e account — tagging API in us-east-1");
		expect(text).toContain("Last 7 days by account:");
	});

	it("says the leak list is partial when only one account was scanned", () => {
		const report = buildReport({
			window: w,
			results: [],
			leakResults: [
				{ cloud: "aws", status: "ok", leaks: [], scope: "platform account — tagging API in us-east-1" },
				{ cloud: "aws", status: "unreadable", reason: "e2e account — SPEND_REPORTER_E2E_ROLE_ARN is unset" },
			],
			fx,
			thresholds: DEFAULT_THRESHOLDS,
			warnings: [],
		});
		const text = renderText(report);
		expect(text).toContain("none found in the scanned scopes");
		expect(text).toContain("scanned AWS: NOT scanned — e2e account — SPEND_REPORTER_E2E_ROLE_ARN is unset");
	});
});
