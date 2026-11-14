// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The response PARSERS of each source, against payloads shaped like each provider's documented
// response. They prove the arithmetic and the field reading; they cannot prove the live API still
// answers in this shape — a workflow_dispatch does that.

import { describe, expect, it } from "vitest";
import { reportWindow } from "../src/dates";
import { parseEcbRates, toEur } from "../src/fx";
import { parseBillOverview, percentEncode, signRpc } from "../src/sources/alibaba";
import { ceGroupLabel, parseCeResults } from "../src/sources/aws";
import { azureQueryBody, parseAzureQuery } from "../src/sources/azure";
import { decodeBudgetMessages, summariseBudgets } from "../src/sources/gcp";
import { estimateHcloud, hcloudInventoryLeaks, hcloudLocation, sevenDays } from "../src/sources/hetzner";

const w = reportWindow(new Date("2026-11-16T07:00:00Z"));

describe("ECB rates", () => {
	const xml = `<gesmes:Envelope><Cube><Cube time='2026-11-13'>
		<Cube currency='USD' rate='1.1550'/><Cube currency='CNY' rate='8.2000'/></Cube></Cube></gesmes:Envelope>`;
	it("parses the daily feed", () => {
		const fx = parseEcbRates(xml);
		expect(fx).toEqual({ date: "2026-11-13", rates: { EUR: 1, USD: 1.155, CNY: 8.2 } });
		expect(toEur(11.55, "usd", fx!)).toBeCloseTo(10);
		expect(toEur(5, "EUR", fx!)).toBe(5);
		expect(toEur(5, "JPY", fx!)).toBeNull();
	});
	it("refuses a document with no rates rather than returning an empty table", () => {
		expect(parseEcbRates("<html>maintenance</html>")).toBeNull();
	});
});

describe("AWS Cost Explorer", () => {
	const page = {
		ResultsByTime: [
			{
				TimePeriod: { Start: "2026-11-09", End: "2026-11-10" },
				Groups: [
					{ Keys: ["Amazon Elastic Container Service for Kubernetes"], Metrics: { UnblendedCost: { Amount: "2.4", Unit: "USD" } } },
					{ Keys: ["Amazon Simple Storage Service"], Metrics: { UnblendedCost: { Amount: "0.1", Unit: "USD" } } },
				],
				Estimated: false,
			},
			{ TimePeriod: { Start: "2026-11-10", End: "2026-11-11" }, Groups: [], Estimated: true },
		],
	};
	it("flattens grouped daily results", () => {
		const r = parseCeResults([page]);
		expect(r.currency).toBe("USD");
		expect(r.estimated).toBe(true);
		expect(r.rows).toEqual([
			{ date: "2026-11-09", key: "Amazon Elastic Container Service for Kubernetes", amount: 2.4 },
			{ date: "2026-11-09", key: "Amazon Simple Storage Service", amount: 0.1 },
		]);
	});
	it("refuses to sum two currencies", () => {
		const mixed = { ResultsByTime: [{ TimePeriod: { Start: "2026-11-09" }, Groups: [
			{ Keys: ["a"], Metrics: { UnblendedCost: { Amount: "1", Unit: "USD" } } },
			{ Keys: ["b"], Metrics: { UnblendedCost: { Amount: "1", Unit: "EUR" } } },
		] }] };
		expect(() => parseCeResults([mixed])).toThrow(/two currencies/);
	});
	it("reads a tag group key as its value", () => {
		expect(ceGroupLabel("alethia:project-id$e2e-123-1")).toBe("e2e-123-1");
		expect(ceGroupLabel("alethia:project-id$")).toBe("(untagged)");
		expect(ceGroupLabel("AmazonEC2")).toBe("AmazonEC2");
	});
});

describe("Azure Cost Management", () => {
	it("reads rows by column NAME, not by position", () => {
		const page = {
			properties: {
				nextLink: null,
				columns: [
					{ name: "Cost", type: "Number" },
					{ name: "UsageDate", type: "Number" },
					{ name: "ServiceName", type: "String" },
					{ name: "Currency", type: "String" },
				],
				rows: [
					[1.5, 20261109, "Azure Kubernetes Service", "EUR"],
					[0.25, 20261110, "Storage", "EUR"],
				],
			},
		};
		expect(parseAzureQuery(page)).toEqual({
			rows: [
				{ date: "2026-11-09", key: "Azure Kubernetes Service", amount: 1.5 },
				{ date: "2026-11-10", key: "Storage", amount: 0.25 },
			],
			currency: "EUR",
			nextLink: null,
		});
	});
	it("fails loudly on a response with no cost column", () => {
		expect(() => parseAzureQuery({ properties: { columns: [{ name: "Foo" }], rows: [] } })).toThrow(/missing cost\/date/);
	});
	it("asks for the whole query span with an INCLUSIVE end of yesterday", () => {
		expect(azureQueryBody(w)).toMatchObject({ timePeriod: { from: "2026-11-01T00:00:00Z", to: "2026-11-15T23:59:59Z" } });
	});
});

/** A Pub/Sub received message carrying one budget notification. */
function msg(id: string, publishTime: string, costAmount: number, costIntervalStart: string) {
	const data = { budgetDisplayName: "alethia-e2e-nightly", costAmount, budgetAmount: 100, currencyCode: "USD", costIntervalStart };
	return { ackId: `a-${id}`, message: { messageId: id, publishTime, data: Buffer.from(JSON.stringify(data)).toString("base64") } };
}

describe("GCP budget notifications", () => {
	it("takes MTD from the latest reading and approximates 7 days from the earliest in the window", () => {
		const ns = decodeBudgetMessages([
			msg("1", "2026-11-09T01:00:00Z", 10, "2026-11-01T08:00:00Z"),
			msg("3", "2026-11-15T22:00:00Z", 17.5, "2026-11-01T08:00:00Z"),
			msg("2", "2026-11-12T01:00:00Z", 14, "2026-11-01T08:00:00Z"),
			msg("2", "2026-11-12T01:00:00Z", 14, "2026-11-01T08:00:00Z"), // a redelivery — deduplicated
		]);
		expect(ns).toHaveLength(3);
		const s = summariseBudgets(ns, w);
		expect(s.mtd).toBe(17.5);
		expect(s.last7Approx).toBe(7.5);
		expect(s.currency).toBe("USD");
		expect(s.latestAt).toBe("2026-11-15T22:00:00Z");
	});
	it("adds the old month's tail to the new month's start across a month boundary", () => {
		const w3 = reportWindow(new Date("2026-11-03T07:00:00Z")); // last7 = 2026-10-27 → 11-02
		const s = summariseBudgets(
			decodeBudgetMessages([
				msg("1", "2026-10-27T01:00:00Z", 80, "2026-10-01"),
				msg("2", "2026-10-31T23:00:00Z", 90, "2026-10-01"),
				msg("3", "2026-11-02T23:00:00Z", 4, "2026-11-01"),
			]),
			w3,
		);
		expect(s.last7Approx).toBe(14); // (90 − 80) + 4
		expect(s.mtd).toBe(4);
	});
	it("has no 7-day figure from a single reading", () => {
		expect(summariseBudgets(decodeBudgetMessages([msg("1", "2026-11-15T01:00:00Z", 3, "2026-11-01")]), w).last7Approx).toBeNull();
	});
	it("skips undecodable messages", () => {
		expect(decodeBudgetMessages([{ message: { data: "not-base64-json", publishTime: "x" } }, "junk"])).toEqual([]);
	});
});

describe("Hetzner estimate", () => {
	const pricing = {
		pricing: {
			currency: "EUR",
			server_backup: { percentage: "20.00" },
			volume: { price_per_gb_month: { net: "0.0440", gross: "0.0524" } },
			image: { price_per_gb_month: { net: "0.0110", gross: "0.0131" } },
			server_types: [
				{ name: "cx22", prices: [{ location: "nbg1", price_hourly: { net: "0.0060" }, price_monthly: { net: "3.7900" } }] },
				{ name: "ccx33", prices: [{ location: "fsn1", price_hourly: { net: "0.0800" }, price_monthly: { net: "48.4900" } }] },
			],
			primary_ips: [{ type: "ipv4", prices: [{ location: "nbg1", price_hourly: { net: "0.0010" }, price_monthly: { net: "0.5000" } }] }],
			floating_ips: [],
			load_balancer_types: [{ name: "lb11", prices: [{ location: "nbg1", price_hourly: { net: "0.0090" }, price_monthly: { net: "5.3900" } }] }],
		},
	};
	const inv = {
		servers: [
			{ id: 1, name: "box", server_type: { name: "ccx33" }, location: { name: "fsn1" }, backup_window: null, labels: {} },
			{ id: 2, name: "e2e-a", server_type: { name: "cx22" }, datacenter: { location: { name: "nbg1" } }, backup_window: "22-02", labels: { "alethia_project-id": "e2e-36135826614-1" } },
		],
		volumes: [{ id: 3, name: "pvc-x", size: 10, location: { name: "nbg1" }, labels: { "alethia_e2e-run": "e2e-36135826614-1" } }],
		primaryIps: [{ id: 4, name: "ip", type: "ipv4", datacenter: { location: { name: "nbg1" } }, assignee_id: null, labels: {} }],
		floatingIps: [],
		loadBalancers: [{ id: 5, name: "lb", load_balancer_type: { name: "lb11" }, location: { name: "nbg1" }, labels: { "alethia_e2e-run": "e2e-staging" } }],
		snapshots: [{ id: 6, description: "talos", image_size: 2, labels: {} }],
	};

	it("caps a week at the monthly price, as Hetzner bills", () => {
		expect(sevenDays(0.08, 48.49)).toBeCloseTo(13.44); // 0.08 × 168 < 48.49
		expect(sevenDays(1, 50)).toBe(50);
		expect(sevenDays(null, 30)).toBe(7);
	});

	it("prices every resource that exists, with backups and the unassigned IP named", () => {
		const e = estimateHcloud(pricing, inv);
		expect(e.unpriced).toEqual([]);
		expect(e.lineItems.map((i) => i.label)).toEqual([
			"server box (ccx33, fsn1)",
			"load balancer lb (lb11, nbg1)",
			"server e2e-a (cx22, nbg1, backups)",
			"primary IP ip (ipv4, UNASSIGNED)",
			"volume pvc-x (10 GB)",
			"snapshot talos (2.0 GB)",
		]);
		const expectWeekly = 13.44 + 0.009 * 168 + 0.006 * 168 * 1.2 + 0.168 + (0.44 * 7) / 30 + (0.022 * 7) / 30;
		expect(e.weekly).toBeCloseTo(expectWeekly, 6);
		expect(e.monthly).toBeCloseTo(48.49 + 5.39 + 3.79 * 1.2 + 0.5 + 0.44 + 0.022, 6);
	});

	it("records what it could not price instead of counting it as free", () => {
		const e = estimateHcloud(pricing, { ...inv, servers: [{ id: 9, name: "odd", server_type: { name: "cax99" }, location: { name: "hel1" } }] });
		expect(e.unpriced).toEqual(["server odd (cax99, hel1)"]);
	});

	it("reads the location from either API shape", () => {
		expect(hcloudLocation({ location: { name: "fsn1" } })).toBe("fsn1");
		expect(hcloudLocation({ datacenter: { location: { name: "nbg1" } } })).toBe("nbg1");
		expect(hcloudLocation({ home_location: { name: "hel1" } })).toBe("hel1");
		expect(hcloudLocation({})).toBeNull();
	});

	it("lists as leaks only the resources an e2e handle attributes", () => {
		expect(hcloudInventoryLeaks(inv).map((l) => [l.id, l.handle, l.key])).toEqual([
			["server/2 (e2e-a)", "e2e-36135826614-1", "project-id"],
			["volume/3 (pvc-x)", "e2e-36135826614-1", "e2e-run"],
			// lb carries `e2e-staging` — not a CI run shape, so not a leak (scope-key.sh's rule).
		]);
	});
});

describe("Alibaba RPC signing", () => {
	it("percent-encodes the way the RPC signature defines it", () => {
		expect(percentEncode("a b*c~d'!")).toBe("a%20b%2Ac~d%27%21");
		expect(percentEncode("/")).toBe("%2F");
	});

	// The worked example in Alibaba Cloud's RPC signature documentation (ECS DescribeRegions, secret
	// "testsecret"). Quoted from the docs, not derived from this implementation.
	it("reproduces the documented DescribeRegions signature", () => {
		const params = {
			Timestamp: "2016-02-23T12:46:24Z",
			Format: "XML",
			AccessKeyId: "testid",
			Action: "DescribeRegions",
			SignatureMethod: "HMAC-SHA1",
			SignatureNonce: "3ee8c1b8-83d3-44af-a94f-4e0ad82fd6cf",
			Version: "2014-05-26",
			SignatureVersion: "1.0",
		};
		expect(signRpc("GET", params, "testsecret")).toBe("OLeaidS1JvxuMvnyHOwuJ+uX5qY=");
	});

	it("sums QueryBillOverview by product", () => {
		const body = { Data: { Items: { Item: [
			{ ProductName: "ECS", PretaxAmount: 3.5, Currency: "USD" },
			{ ProductName: "ECS", PretaxAmount: "1.5", Currency: "USD" },
			{ ProductCode: "slb", PretaxAmount: 2, Currency: "USD" },
		] } } };
		expect(parseBillOverview(body)).toEqual({
			currency: "USD",
			total: 7,
			items: [
				{ label: "ECS", amount: 5 },
				{ label: "slb", amount: 2 },
			],
		});
	});
});
