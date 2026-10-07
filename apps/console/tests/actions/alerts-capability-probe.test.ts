// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5660: the alerts bootstrap's `canManage` flag is a capability PROBE — it shows or hides
// controls and authorizes nothing — so it must not write to the org's audit trail. It used to
// probe with `getPdp().enforce(...)`, and `enforce` routes through `enforceDecision`, which records
// every non-read allow and every deny and emits the action event. So every overview / alerts-hub
// load wrote "managed alerts" (or, for a non-manager, a DENIAL) into `authz_activity_log`.
//
// Unlike tests/actions/alerts.test.ts, which stubs the PDP and the guard outright and so can see
// neither, this file keeps the REAL recording path end to end: the real `authorize()` (through
// `runWithActor`, its documented injected-actor seam), the real `PostgresRbacPDP.enforce`, and the
// real `enforceDecision` / `recordActivity`. Only the grant lookup (`can`) is stubbed, plus the DB
// handle (so the activity INSERT is observable) and the action-event emitter.
//
// The second half is the other side of the same fix: a real mutation must STILL record. A probe
// that stopped recording is only correct because every write re-checks with the recording gate.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitActionEvent: vi.fn() }));
vi.mock("@/lib/alerts/rule-cache", () => ({ invalidateOrgRules: vi.fn() }));
vi.mock("@/lib/alerts/channels", () => ({ getChannelSender: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/crypto/secrets", () => ({
	encryptSecret: vi.fn(),
	isCredEncryptionConfigured: vi.fn(() => true),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// The guard's session-resolution dependencies. Never reached — the actor is injected — but
// stubbed so importing the real guard does not pull in the auth runtime.
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz/org-scope", () => ({ urlScopedOrgId: vi.fn() }));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));

import {
	deleteChannel,
	deletePolicy,
	getAlertsBootstrap,
	setChannelEnabled,
	togglePolicy,
} from "@/app/server/actions/alerts";
import { emitActionEvent } from "@/lib/alerts/emit";
import { getPdp } from "@/lib/authz";
import { runWithActor } from "@/lib/authz/actor-context";
import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import type { Actor, Decision } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog } from "@/lib/db/schema";
import { COMMUNITY_ENTITLEMENTS } from "@/lib/billing/plan";

const ACTOR: Actor = {
	orgId: "org-1",
	userId: "user-1",
	entitlements: { ...COMMUNITY_ENTITLEMENTS, alerting: true },
};

/** Every row handed to `insert(authz_activity_log).values(...)` — the audit trail. */
let activityRows: Record<string, unknown>[];

/**
 * A thenable drizzle stand-in: every query builder resolves to `[]`, and an INSERT into
 * `authz_activity_log` is captured into {@link activityRows}.
 */
function installDb(): void {
	const builder = (): Record<string, unknown> => {
		const b: Record<string, unknown> = {};
		Object.assign(b, {
			from: () => b,
			innerJoin: () => b,
			where: () => b,
			orderBy: () => b,
			limit: () => b,
			set: () => b,
			returning: () => [],
			then: (resolve: (v: unknown) => void) => resolve([]),
		});
		return b;
	};
	const db = {
		select: () => builder(),
		update: () => builder(),
		delete: () => builder(),
		insert: (table: unknown) => {
			const b = builder();
			b.values = (row: Record<string, unknown>) => {
				if (table === authzActivityLog) activityRows.push(row);
				return b;
			};
			b.catch = () => undefined;
			return b;
		},
	};
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

/**
 * Installs the REAL community PDP with only its grant lookup stubbed: `manage_alerts` resolves
 * to `manage`, and every read (`view_alerts`) is allowed.
 */
function installPdp(manage: Decision): void {
	const pdp = new PostgresRbacPDP();
	vi.spyOn(pdp, "can").mockImplementation(async (_actor, action) =>
		action === "manage_alerts" ? manage : { allowed: true },
	);
	vi.mocked(getPdp).mockReturnValue(pdp);
}

/** The audit rows and action events written for `manage_alerts`. */
function manageAlertsTrail() {
	return {
		rows: activityRows.filter((r) => r.action === "manage_alerts"),
		events: vi
			.mocked(emitActionEvent)
			.mock.calls.filter(([, action]) => action === "manage_alerts"),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	activityRows = [];
	installDb();
});

describe("getAlertsBootstrap — the canManage probe records nothing (#5660)", () => {
	it("a manager loading the page writes no manage_alerts activity row and emits no event", async () => {
		installPdp({ allowed: true });
		const r = await runWithActor(ACTOR, () => getAlertsBootstrap());
		expect(r.canManage).toBe(true);
		expect(manageAlertsTrail()).toEqual({ rows: [], events: [] });
	});

	it("a non-manager loading the page writes no DENIAL row and emits no denied event", async () => {
		installPdp({ allowed: false, reason: "no_grant" });
		const r = await runWithActor(ACTOR, () => getAlertsBootstrap());
		expect(r.canManage).toBe(false);
		expect(manageAlertsTrail()).toEqual({ rows: [], events: [] });
	});
});

describe("alert mutations still go through the RECORDING gate", () => {
	// Each of these is a write whose only body is a row change, so it runs to completion against the
	// empty DB stand-in; the richer writes (addChannel, createPolicy, …) share the same first line.
	it.each([
		["deletePolicy", () => deletePolicy("rule-1")],
		["togglePolicy", () => togglePolicy("rule-1", false)],
		["deleteChannel", () => deleteChannel("ch-1")],
		["setChannelEnabled", () => setChannelEnabled("ch-1", false)],
	])("an allowed %s records a manage_alerts row and emits the allowed event", async (_name, run) => {
		installPdp({ allowed: true });
		await runWithActor(ACTOR, run);
		const { rows, events } = manageAlertsTrail();
		expect(rows).toEqual([
			expect.objectContaining({
				org_id: "org-1",
				actor_id: "user-1",
				resource_type: "alert",
				decision: true,
			}),
		]);
		expect(events).toHaveLength(1);
		expect(events[0][3]).toBe(true);
	});

	it("a denied deletePolicy throws, records the DENIAL and emits the denied event", async () => {
		installPdp({ allowed: false, reason: "no_grant" });
		await expect(runWithActor(ACTOR, () => deletePolicy("rule-1"))).rejects.toThrow();
		const { rows, events } = manageAlertsTrail();
		expect(rows).toEqual([
			expect.objectContaining({ decision: false, reason: "no_grant" }),
		]);
		expect(events).toHaveLength(1);
		expect(events[0][3]).toBe(false);
	});
});
