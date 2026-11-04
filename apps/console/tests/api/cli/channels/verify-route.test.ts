// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/channels/:id/verify — the CLI twin of the console's verifyChannel (#6125 review).
//   · Both the read AND the verified-stamp write are bound to the caller's organization.
//   · A destination the outbound guard refuses is answered with one fixed sentence; the guard's own
//     message (how the destination resolved) is never returned.

import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
const verify = vi.fn();
vi.mock("@/lib/alerts/channels", () => ({ getChannelSender: () => ({ verify }) }));

import { POST } from "@/app/api/cli/channels/[id]/verify/route";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { SsrfError } from "@/lib/net/ssrf-guard";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const ID = "22222222-2222-4222-8222-222222222222";

const row = {
	id: ID,
	org_id: ORG,
	type: "webhook",
	name: "hook",
	enabled: true,
	is_verified: true,
	config: { recipients: [] },
	secret: null,
	last_verified_at: new Date("2026-10-27T10:00:00Z"),
	created_at: new Date("2026-10-01T10:00:00Z"),
};

/** The WHERE clauses each statement was given, rendered to SQL text with their parameters. */
const wheres: { sql: string; params: unknown[] }[] = [];

/** A drizzle stand-in: the select finds the row; the update returns it. */
function fakeDb() {
	const dialect = new PgDialect();
	const record = (cond: SQL) => wheres.push(dialect.sqlToQuery(cond));
	const select = {
		from: () => select,
		where: (cond: SQL) => {
			record(cond);
			return select;
		},
		limit: () => Promise.resolve([row]),
	};
	const update = {
		set: () => update,
		where: (cond: SQL) => {
			record(cond);
			return update;
		},
		returning: () => Promise.resolve([row]),
	};
	return { select: () => select, update: () => update };
}

/** Calls the route for the channel. */
function call() {
	return POST(new Request(`http://console.test/api/cli/channels/${ID}/verify`, { method: "POST" }), {
		params: Promise.resolve({ id: ID }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	wheres.length = 0;
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { credential: "session", userId: USER, orgId: ORG },
		credential: "session",
		orgScope: [ORG, USER],
	});
	vi.mocked(getServiceDb).mockReturnValue(fakeDb() as never);
});

describe("POST /api/cli/channels/:id/verify", () => {
	it("binds the verified-stamp write to the caller's organization, not just the id", async () => {
		verify.mockResolvedValue(undefined);
		const res = await call();
		expect(res.status).toBe(200);
		expect(wheres).toHaveLength(2);
		const [, write] = wheres;
		expect(write.sql).toMatch(/"org_id" = \$\d/);
		expect(write.params).toEqual(expect.arrayContaining([ID, ORG]));
	});

	it("a destination the outbound guard refuses gets one fixed sentence — never the guard's own words", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		verify.mockRejectedValue(new SsrfError("Refusing to connect to non-public address 10.1.2.3 for host internal.example"));
		const res = await call();
		expect(res.status).toBe(400);
		const body = await res.text();
		expect(JSON.parse(body)).toEqual({ error: "This destination isn't publicly reachable over HTTPS." });
		expect(body).not.toContain("10.1.2.3");
		expect(body).not.toContain("internal.example");
		warn.mockRestore();
	});
});
