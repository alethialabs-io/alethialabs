// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6130: a case page's crumb is its case NUMBER, never its UUID (F044); and the `support` topic
// reaches every key the support pages read, so a staff reply refreshes the open case and "My cases"
// as well as the bell — the pages poll nothing.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { buildCrumbs } from "@/components/shell/breadcrumb-trail";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { orpc } from "@/lib/rpc/client";

const CASE = "d38f58b3-ed49-4bd4-b7a1-0123456789ab";
const PATH = `/acme/~/support/cases/${CASE}`;

describe("the case crumb (F044)", () => {
	it("reads the case number the resolver gives", () => {
		const crumbs = buildCrumbs(PATH, undefined, (id) => (id === CASE ? "CASE-000002" : undefined));
		expect(crumbs.at(-1)).toEqual({ label: "CASE-000002" });
		expect(crumbs.map((c) => c.label)).toEqual(["Support", "My cases", "CASE-000002"]);
	});

	it("reads 'Case' — never the raw id — when the case is not in the feed", () => {
		const crumbs = buildCrumbs(PATH);
		expect(crumbs.at(-1)).toEqual({ label: "Case" });
		expect(crumbs.some((c) => c.label.includes(CASE.slice(0, 8)))).toBe(false);
	});

	it("leaves a job id to the job resolver (the case rule is support/cases only)", () => {
		const crumbs = buildCrumbs(`/acme/~/jobs/${CASE}`, () => "Plan", () => "CASE-000002");
		expect(crumbs.at(-1)).toEqual({ label: "Plan" });
	});
});

describe("the support topic reaches every support read (#6130)", () => {
	const reads: Array<[string, readonly unknown[]]> = [
		["the bell's feed", orpc.workspace.supportCases.queryOptions().queryKey],
		["My cases, All", orpc.support.cases.queryOptions({ input: { bucket: "all" } }).queryKey],
		["My cases, Active", orpc.support.cases.queryOptions({ input: { bucket: "active" } }).queryKey],
		["the open case", orpc.support.case.queryOptions({ input: { id: CASE } }).queryKey],
	];

	it.each(reads)("%s is invalidated by a support hint", async (_name, key) => {
		const client = new QueryClient();
		client.setQueryData(key, []);
		for (const k of TOPIC_KEYS.support()) await client.invalidateQueries({ queryKey: k });
		expect(client.getQueryState(key)?.isInvalidated).toBe(true);
	});

	it("a jobs hint leaves them alone", async () => {
		const client = new QueryClient();
		const key = orpc.support.case.queryOptions({ input: { id: CASE } }).queryKey;
		client.getQueryCache().build(client, { queryKey: key });
		for (const k of TOPIC_KEYS.jobs()) await client.invalidateQueries({ queryKey: k });
		expect(client.getQueryState(key)?.isInvalidated).toBe(false);
	});
});
