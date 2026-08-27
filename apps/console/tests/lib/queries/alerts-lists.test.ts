// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub's three lists — channels, policies and the delivery ledger.
//
// Three things here are worth a test rather than a reading:
//
//   * `toChannelDTO` must never carry the encrypted secret off the server. It reports
//     `has_secret` and nothing else, and that is a security property, not a formatting one.
//   * a channel's DISPLAY name ("Rocket.Chat") is a constant in the transport catalog, not a
//     column. Searching for it has to be resolved to a VALUE LIST and matched in SQL, or the
//     panel silently cannot find its own rows.
//   * the ledger is filtered and THEN windowed, and `total` describes the whole ledger rather
//     than the window — otherwise the count beside a facet option contradicts the filter that
//     produced it. The window is also capped, so a client cannot ask for the entire ledger.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockChainDb } from "./_list-query-db";

vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		ilike: vi.fn(actual.ilike),
		inArray: vi.fn(actual.inArray),
		exists: vi.fn(actual.exists),
	};
});

const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb }));

import { exists, ilike, inArray } from "drizzle-orm";
import {
	CHANNEL_STATUSES,
	POLICY_KINDS,
	POLICY_STATUSES,
	queryAlertChannelsPage,
	queryAlertDeliveriesPage,
	queryAlertPoliciesPage,
	toChannelDTO,
	toDeliveryDTO,
	toPolicyDTO,
} from "@/lib/queries/alerts-lists";

const CREATED = new Date("2026-08-01T12:00:00.000Z");

function seed(...sets: unknown[][]) {
	const { db, chains } = mockChainDb(sets);
	getServiceDb.mockReturnValue(db);
	return chains;
}

function channelRow(over: Record<string, unknown> = {}) {
	return {
		id: "c1",
		org_id: "org-1",
		type: "slack",
		name: "#platform-alerts",
		enabled: true,
		is_verified: true,
		config: { recipients: ["ops@x.io"] },
		secret: "enc:v1:aaaaaaaaaaaaaaaaaaaa",
		last_verified_at: CREATED,
		created_at: CREATED,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("toChannelDTO", () => {
	it("reports that a secret EXISTS and never carries its value", () => {
		const dto = toChannelDTO(channelRow() as never);
		expect(dto.has_secret).toBe(true);
		expect(JSON.stringify(dto)).not.toContain("enc:v1:");
		expect(Object.keys(dto)).not.toContain("secret");
	});

	it("defaults recipients to an empty list and nulls an unverified timestamp", () => {
		const dto = toChannelDTO(
			channelRow({ config: {}, secret: null, last_verified_at: null }) as never,
		);
		expect(dto.recipients).toEqual([]);
		expect(dto.has_secret).toBe(false);
		expect(dto.last_verified_at).toBeNull();
	});
});

describe("toPolicyDTO", () => {
	it("keeps channelIds in step with channels, so the two cannot disagree", () => {
		const channels = [
			{ id: "c1", minSeverity: null },
			{ id: "c2", minSeverity: "warning" as const },
		];
		const dto = toPolicyDTO(
			{
				id: "r1",
				name: "Failed jobs",
				description: null,
				event_patterns: ["job.failed"],
				severity: "warning",
				match: null,
				throttle_seconds: 0,
				escalate: false,
				recipient: null,
				enabled: true,
			} as never,
			channels,
			false,
		);
		expect(dto.channels).toEqual(channels);
		expect(dto.channelIds).toEqual(["c1", "c2"]);
		expect(dto.is_security).toBe(false);
	});
});

describe("toDeliveryDTO", () => {
	it("lifts the title out of the context JSONB and nulls an unsent timestamp", () => {
		const dto = toDeliveryDTO({
			id: "d1",
			event_key: "authz.denied",
			status: "pending",
			context: { title: "Access denied" },
			attempts: 2,
			last_error: null,
			created_at: CREATED,
			sent_at: null,
		} as never);
		expect(dto).toEqual({
			id: "d1",
			event_key: "authz.denied",
			status: "pending",
			title: "Access denied",
			attempts: 2,
			last_error: null,
			created_at: "2026-08-01T12:00:00.000Z",
			sent_at: null,
		});
	});
});

describe("queryAlertChannelsPage", () => {
	it("returns DTOs and counts types + statuses over the unfiltered org", async () => {
		seed(
			[channelRow()],
			[
				{ type: "slack", enabled: true, is_verified: true },
				{ type: "slack", enabled: true, is_verified: false },
				{ type: "email", enabled: false, is_verified: true },
			],
		);

		const page = await queryAlertChannelsPage("org-1", { status: ["verified"] });

		expect(page.rows).toHaveLength(1);
		expect(page.rows[0].id).toBe("c1");
		expect(page.resultCount).toBe(1);
		expect(page.total).toBe(3);
		expect(page.facets.status).toEqual([
			{ value: "verified", label: null, count: 1 },
			{ value: "unverified", label: null, count: 1 },
			{ value: "paused", label: null, count: 1 },
		]);
		// Types are listed in the transport CATALOG's order (slack before email), not
		// alphabetically and not by count — and only the ones in use appear at all.
		expect(page.facets.types.map((o) => o.value)).toEqual(["slack", "email"]);
		expect(page.facets.types.every((o) => typeof o.label === "string")).toBe(true);
		expect(page.facets.types.find((o) => o.value === "slack")?.count).toBe(2);
	});

	it("classifies a disabled channel as paused even when it is verified", async () => {
		seed([], [{ type: "slack", enabled: false, is_verified: true }]);
		const page = await queryAlertChannelsPage("org-1");
		expect(page.facets.status).toEqual([
			{ value: "verified", label: null, count: 0 },
			{ value: "unverified", label: null, count: 0 },
			{ value: "paused", label: null, count: 1 },
		]);
	});

	it("resolves a transport's DISPLAY name to a type list and matches it in SQL", async () => {
		seed([], []);
		await queryAlertChannelsPage("org-1", { search: "rocket" });
		// "rocket" appears in no column — the row's type is `rocketchat`, its label is
		// "Rocket.Chat". So the search has to become an inArray over the matching types.
		const typeLists = vi
			.mocked(inArray)
			.mock.calls.map((c) => c[1])
			.filter((v): v is string[] => Array.isArray(v));
		expect(typeLists.some((list) => list.includes("rocketchat"))).toBe(true);
	});

	it("still searches the name when no transport label matches", async () => {
		seed([], []);
		await queryAlertChannelsPage("org-1", { search: "zzz-no-transport-has-this" });
		expect(ilike).toHaveBeenCalledTimes(1);
		expect(vi.mocked(inArray)).not.toHaveBeenCalled();
	});

	it("gives the facet pass the org predicate alone", async () => {
		const chains = seed([], []);
		await queryAlertChannelsPage("org-1", { search: "ops", types: ["slack"] });
		const [rowsPass, facetPass] = chains;
		expect(rowsPass.called("orderBy")).toBe(true);
		expect(facetPass.argsOf("where")).toHaveLength(1);
		expect(facetPass.called("orderBy")).toBe(false);
	});

	it("exposes the three channel status buckets", () => {
		expect(CHANNEL_STATUSES).toEqual(["verified", "unverified", "paused"]);
	});
});

describe("queryAlertPoliciesPage", () => {
	function policyRow(over: Record<string, unknown> = {}) {
		return {
			id: "r1",
			org_id: "org-1",
			name: "Failed jobs",
			description: "Any job that fails",
			event_patterns: ["job.failed"],
			severity: "warning",
			match: null,
			throttle_seconds: 0,
			escalate: false,
			recipient: null,
			enabled: true,
			created_at: CREATED,
			...over,
		};
	}

	it("joins bindings onto their rules and counts every configured destination", async () => {
		seed(
			// rules
			[{ rule: policyRow(), isSecurity: false }],
			// bindings of every rule in the org
			[
				{
					alert_rule_channels: { rule_id: "r1", channel_id: "c1", min_severity: "warning" },
				},
			],
			// facet rules
			[
				{ enabled: true, isSecurity: false },
				{ enabled: false, isSecurity: true },
			],
			// facet bindings
			[{ channelId: "c1" }],
			// facet channels
			[
				{ id: "c1", name: "#platform-alerts" },
				{ id: "c2", name: "#quiet-channel" },
			],
		);

		const page = await queryAlertPoliciesPage("org-1");

		expect(page.rows).toHaveLength(1);
		expect(page.rows[0].channels).toEqual([{ id: "c1", minSeverity: "warning" }]);
		expect(page.rows[0].channelIds).toEqual(["c1"]);
		expect(page.total).toBe(2);
		expect(page.facets.status).toEqual([
			{ value: "enabled", label: null, count: 1 },
			{ value: "off", label: null, count: 1 },
		]);
		expect(page.facets.kinds).toEqual([
			{ value: "security", label: null, count: 1 },
			{ value: "operational", label: null, count: 1 },
		]);
		// A destination nothing routes to must still be selectable — it is how you discover
		// that nothing routes to it.
		expect(page.facets.channels).toEqual([
			{ value: "c1", label: "#platform-alerts", count: 1 },
			{ value: "c2", label: "#quiet-channel", count: 0 },
		]);
	});

	it("gives a policy with no bindings an empty channel list, not undefined", async () => {
		seed([{ rule: policyRow(), isSecurity: true }], [], [], [], []);
		const page = await queryAlertPoliciesPage("org-1");
		expect(page.rows[0].channels).toEqual([]);
		expect(page.rows[0].is_security).toBe(true);
	});

	it("builds no status predicate when BOTH statuses are selected", async () => {
		// Selecting everything is the same question as selecting nothing, and a predicate for
		// it is a WHERE the database has to evaluate for no benefit.
		const chains = seed([], [], [], [], []);
		await queryAlertPoliciesPage("org-1", { status: ["enabled", "off"] });
		// One org predicate, and no filter conditions spread in beside it.
		expect(chains[0].argsOf("where")).toHaveLength(1);
	});

	it("filters by channel through an EXISTS rather than a join", async () => {
		const chains = seed([], [], [], [], []);
		await queryAlertPoliciesPage("org-1", { channels: ["c1", "c2"] });
		expect(exists).toHaveBeenCalledTimes(1);
		// The subquery chain is created but never awaited, so it takes no result set.
		expect(chains.filter((c) => !c.awaited)).toHaveLength(1);
	});

	it("gives all three facet passes the org predicate alone", async () => {
		const chains = seed([], [], [], [], []);
		await queryAlertPoliciesPage("org-1", { search: "failed", kinds: ["security"] });
		// Creation order: rows, bindings, facet(rules), facet(bindings), facet(channels).
		for (const facet of [chains[2], chains[3], chains[4]]) {
			expect(facet.argsOf("where")).toHaveLength(1);
		}
		// name + description, in the rows pass only.
		expect(vi.mocked(ilike).mock.calls).toHaveLength(2);
	});

	it("exposes both status and kind vocabularies", () => {
		expect(POLICY_STATUSES).toEqual(["enabled", "off"]);
		expect(POLICY_KINDS).toEqual(["security", "operational"]);
	});
});

describe("queryAlertDeliveriesPage", () => {
	function deliveryRow(over: Record<string, unknown> = {}) {
		return {
			id: "d1",
			org_id: "org-1",
			event_key: "job.failed",
			status: "sent",
			context: { title: "Nightly build failed" },
			attempts: 1,
			last_error: null,
			created_at: CREATED,
			sent_at: CREATED,
			...over,
		};
	}

	it("reports the WHOLE ledger as total, not the size of the window", async () => {
		seed(
			[deliveryRow()],
			[
				{ status: "sent", n: 900 },
				{ status: "failed", n: 12 },
			],
		);
		const page = await queryAlertDeliveriesPage("org-1", { status: ["failed"] });
		expect(page.rows).toHaveLength(1);
		expect(page.resultCount).toBe(1);
		expect(page.total).toBe(912);
		expect(page.facets.status).toEqual([
			{ value: "sent", label: null, count: 900 },
			{ value: "pending", label: null, count: 0 },
			{ value: "failed", label: null, count: 12 },
			{ value: "dead", label: null, count: 0 },
		]);
	});

	it("windows at 50 by default and caps a client's ask at 200", async () => {
		const cases: [number | undefined, number][] = [
			[undefined, 50],
			[10, 10],
			[10_000, 200],
			[0, 1],
			[-5, 1],
			[25.9, 25],
		];
		for (const [asked, expected] of cases) {
			const chains = seed([], []);
			await queryAlertDeliveriesPage("org-1", { limit: asked });
			expect(chains[0].argsOf("limit")).toEqual([expected]);
		}
	});

	it("searches the event key and the rendered title, and nothing in the facet pass", async () => {
		const chains = seed([], []);
		await queryAlertDeliveriesPage("org-1", { search: "build" });
		expect(vi.mocked(ilike).mock.calls).toHaveLength(2);
		const [rowsPass, facetPass] = chains;
		expect(rowsPass.called("limit")).toBe(true);
		expect(facetPass.argsOf("where")).toHaveLength(1);
		// The facet counts come from a grouped aggregate, not from fetching and tallying.
		expect(facetPass.called("groupBy")).toBe(true);
		expect(facetPass.called("limit")).toBe(false);
	});

	it("drops a status list that narrows to nothing rather than emitting an empty IN", async () => {
		const chains = seed([], []);
		await queryAlertDeliveriesPage("org-1", { status: ["definitely-not-a-status"] });
		expect(vi.mocked(inArray)).not.toHaveBeenCalled();
		expect(chains[0].argsOf("where")).toHaveLength(1);
	});
});
