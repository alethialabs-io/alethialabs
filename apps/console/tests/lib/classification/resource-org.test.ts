// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Unit: which table each classifiable kind is checked against, and what the answer is when that
// lookup matches or does not. The org predicates themselves are SQL and are asserted against real
// Postgres in tests/integration/org-bound-decisions.test.ts; this file pins the per-kind routing,
// so a kind added to the enum without a case here fails `tsc`, and a case reading the wrong table
// fails below.

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
	/** Every table a lookup read FROM, in order. */
	const tables: unknown[] = [];
	/** The rows the next awaited lookup resolves to. */
	const next: { rows: unknown[] } = { rows: [] };
	/** A drizzle-shaped select builder: each step returns itself; awaiting it yields `next.rows`. */
	const chain = {
		from(t: unknown) {
			tables.push(t);
			return chain;
		},
		innerJoin: () => chain,
		where: () => chain,
		limit: () => chain,
		then: (resolve: (rows: unknown[]) => void) => resolve(next.rows),
	};
	const db = { select: () => chain };
	return { db, tables, next };
});

vi.mock("@/lib/db", () => ({ getServiceDb: () => fake.db }));

import { classifiableResourceInOrg } from "@/lib/classification/resource-org";
import {
	alertChannels,
	alertDeliveries,
	alertRules,
	cloudIdentities,
	cloudKubernetesClusters,
	connectorCredentials,
	member,
	projectCluster,
	projectEnvironments,
	projects,
	role,
	runners,
	runnerUsageSessions,
	supportCases,
} from "@/lib/db/schema";
import type { ResourceKind } from "@/lib/db/schema/enums";

const SCOPE = { orgId: "org-a", userId: "user-1" };

const TABLE_FOR: [ResourceKind, unknown][] = [
	["cloud_identity", cloudIdentities],
	["connector_credential", connectorCredentials],
	["alert_rule", alertRules],
	["alert_channel", alertChannels],
	["alert_delivery", alertDeliveries],
	["member", member],
	["project", projects],
	["project_environment", projectEnvironments],
	["project_cluster", projectCluster],
	["cloud_kubernetes_cluster", cloudKubernetesClusters],
	["role", role],
	["runner", runners],
	["runner_usage_session", runnerUsageSessions],
	["support_case", supportCases],
];

beforeEach(() => {
	fake.tables.length = 0;
	fake.next.rows = [];
});

describe("classifiableResourceInOrg", () => {
	it.each(TABLE_FOR)("%s: reads its own table and is true when the bound lookup matches", async (kind, table) => {
		fake.next.rows = [{ id: "r-1" }];
		await expect(classifiableResourceInOrg(kind, "r-1", SCOPE)).resolves.toBe(true);
		expect(fake.tables).toEqual([table]);
	});

	it.each(TABLE_FOR)("%s: is false when the bound lookup matches nothing", async (kind) => {
		await expect(classifiableResourceInOrg(kind, "r-1", SCOPE)).resolves.toBe(false);
	});

	it("member: a personal workspace's owner is its one member, without a lookup", async () => {
		const personal = { orgId: "user-1", userId: "user-1" };
		await expect(classifiableResourceInOrg("member", "user-1", personal)).resolves.toBe(true);
		expect(fake.tables).toEqual([]);
	});

	it("member: in a team org the caller's user id is not a member id", async () => {
		await expect(classifiableResourceInOrg("member", "user-1", SCOPE)).resolves.toBe(false);
		expect(fake.tables).toEqual([member]);
	});
});
