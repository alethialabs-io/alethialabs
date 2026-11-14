// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { render } from "@react-email/components";
import { describe, expect, it } from "vitest";
import { buildReport, DEFAULT_THRESHOLDS } from "../src/aggregate";
import { reportWindow } from "../src/dates";
import { SpendReportEmail } from "../src/email";
import { cloudLine, fmtDelta, fmtMoney, renderText, subjectLine } from "../src/render-text";

const report = buildReport({
	window: reportWindow(new Date("2026-11-16T07:00:00Z")),
	fx: { date: "2026-11-13", rates: { EUR: 1, USD: 1.25 } },
	thresholds: { ...DEFAULT_THRESHOLDS, aws: 30 },
	warnings: ["SPEND_REPORT_THRESHOLDS_EUR: unknown cloud \"vercel\" ignored."],
	results: [
		{
			cloud: "aws",
			status: "ok",
			currency: "USD",
			last7: 50,
			prior7: 25,
			mtd: 100,
			estimate: false,
			lineItemBasis: "7d",
			lineItems: [{ label: "Amazon EKS", amount: 40 }],
			breakdowns: [{ title: "Last 7 days by alethia:project-id", items: [{ label: "e2e-1-1", amount: 30 }] }],
			notes: [],
		},
		{ cloud: "azure", status: "unreadable", reason: "SPEND_AZURE_CLIENT_ID is unset (apply infra/azure-e2e)" },
		{ cloud: "gcp", status: "ok", currency: "USD", last7: null, prior7: null, mtd: 0, estimate: false, lineItemBasis: "mtd", lineItems: [], breakdowns: [], notes: ["Billing account 01-02-03 is CLOSED — nothing new accrues on it; any figure below is what was billed before it closed."] },
		{ cloud: "hetzner", status: "ok", currency: "EUR", last7: 4.5, prior7: null, mtd: null, estimate: true, lineItemBasis: "est-7d", lineItems: [{ label: "server box (ccx33, fsn1)", amount: 4.5 }], breakdowns: [], notes: [] },
		{ cloud: "alibaba", status: "unreadable", reason: "the e2e RAM role refused this job" },
	],
	leakResults: [{ cloud: "aws", status: "ok", scope: "tagging API in us-east-1", leaks: [{ cloud: "aws", id: "arn:aws:ec2:us-east-1:1:vpc/vpc-1", kind: "ec2:vpc", handle: "e2e-1-1", key: "project-id" }] }],
});

describe("formatting", () => {
	it("prints money with its code and n/a for unknown", () => {
		expect(fmtMoney(12.345, "EUR")).toBe("EUR 12.35");
		expect(fmtMoney(-3, "USD")).toBe("-USD 3.00");
		expect(fmtMoney(null, "EUR")).toBe("n/a");
	});
	it("prints a delta with its sign", () => {
		expect(fmtDelta({ abs: 3.4, pct: 12.2 }, "EUR")).toBe("+12% (+EUR 3.40)");
		expect(fmtDelta({ abs: -1, pct: -50 }, "EUR")).toBe("-50% (-EUR 1.00)");
		expect(fmtDelta({ abs: 2, pct: null }, "EUR")).toBe("+EUR 2.00 (no prior spend)");
		expect(fmtDelta(null, "EUR")).toBe("n/a");
	});
});

describe("text rendering", () => {
	const text = renderText(report);
	it("puts the total, WoW and flag count in the subject", () => {
		expect(subjectLine(report)).toBe("Cloud spend, week to 2026-11-15: EUR 44.50 (+100% WoW) — 2 flags — 2 of 5 clouds not readable");
	});
	it("states an unreadable cloud plainly instead of omitting it", () => {
		expect(text).toContain("Azure: not readable — SPEND_AZURE_CLIENT_ID is unset (apply infra/azure-e2e)");
		expect(text).toContain("Alibaba: not readable — the e2e RAM role refused this job");
	});
	it("shows EUR and the native currency, and labels the estimate", () => {
		expect(cloudLine(report.rows[0]!)).toBe("AWS: 7d EUR 40.00 [USD 50.00] · WoW +100% (+USD 25.00) · MTD EUR 80.00 [USD 100.00]");
		expect(text).toContain("Hetzner (estimate): 7d EUR 4.50");
	});
	it("carries the red flags, top items, leaks, closed-account note and config warnings", () => {
		expect(text).toContain("! AWS spent EUR 40.00 (last 7 days), over its EUR 30.00 threshold.");
		expect(text).toContain(" 1. AWS · Amazon EKS: EUR 32.00 [USD 40.00] (7 days)");
		expect(text).toContain("AWS · e2e-1-1: 1 resource(s) — ec2:vpc");
		expect(text).toContain("is CLOSED");
		expect(text).toContain("Last 7 days by alethia:project-id:");
		expect(text).toContain('Note: SPEND_REPORT_THRESHOLDS_EUR: unknown cloud "vercel" ignored.');
		expect(text).toContain("The 7-day total leaves out: Azure, GCP, Alibaba");
	});
});

describe("email rendering", () => {
	it("renders every section into the HTML", async () => {
		// React separates adjacent text nodes with `<!-- -->`; a reader sees one string, so the test does.
		const html = (await render(<SpendReportEmail report={report} />)).replaceAll("<!-- -->", "");
		for (const needle of [
			"EUR 44.50 in 7 days",
			"Red flags",
			"over its EUR 30.00 threshold",
			"not readable — SPEND_AZURE_CLIENT_ID is unset",
			"Top 10 line items",
			"Amazon EKS",
			"Leak list",
			"arn:aws:ec2:us-east-1:1:vpc/vpc-1",
			"(estimate)",
			"ECB reference rates of 2026-11-13",
		]) {
			expect(html).toContain(needle);
		}
	});
	it("omits the red-flag box when nothing is flagged", async () => {
		const quiet = buildReport({ window: report.window, fx: { date: null, rates: { EUR: 1 } }, thresholds: DEFAULT_THRESHOLDS, warnings: [], results: [], leakResults: [] });
		const html = await render(<SpendReportEmail report={quiet} />);
		expect(html).not.toContain("Red flags");
		// Nothing was scanned, so the leak list must not read as clean.
		expect(html).toContain("Not known — no cloud could be scanned");
		expect(html).not.toContain("No resource still carries an e2e handle");
		expect(renderText(quiet)).toContain("NOT KNOWN — no cloud could be scanned");
	});
	it("reads as clean only when a scan actually ran", async () => {
		const clean = buildReport({ window: report.window, fx: { date: null, rates: { EUR: 1 } }, thresholds: DEFAULT_THRESHOLDS, warnings: [], results: [], leakResults: [{ cloud: "hetzner", status: "ok", leaks: [], scope: "labels" }] });
		expect((await render(<SpendReportEmail report={clean} />)).replaceAll("<!-- -->", "")).toContain("No resource still carries an e2e handle");
		expect(renderText(clean)).toContain("none found in the scanned scopes");
	});
});
