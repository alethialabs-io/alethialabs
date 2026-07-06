// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alert ingest (lib/alerts/emit.ts → emitAlertEvent). Mocked boundary: stub the enabled-rules
// cache, org entitlements, dispatch, and a drizzle chain whose channels SELECT (where-terminal),
// throttle SELECT (`.limit`), and insert (`.returning`) resolve independently. The pure matchers
// (catalog/events) stay REAL. Drives: rule glob + field match, the authz.* open-core gate, the
// throttle skip, the channel fan-out, and the delivery-row shape.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/alerts/rule-cache", () => ({ getEnabledRules: vi.fn() }));
vi.mock("@/lib/billing/queries", () => ({ resolveOrgEntitlements: vi.fn() }));
vi.mock("@/lib/alerts/dispatch", () => ({ dispatchDeliveries: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { emitActionEvent, emitAlertEvent, emitAlertEventSafe } from "@/lib/alerts/emit";
import { getEnabledRules } from "@/lib/alerts/rule-cache";
import { resolveOrgEntitlements } from "@/lib/billing/queries";
import { dispatchDeliveries } from "@/lib/alerts/dispatch";
import { getServiceDb } from "@/lib/db";

function mockDb(opts: {
	channels?: Array<{ channel_id: string }>;
	throttleHit?: boolean;
	inserted?: unknown[];
}) {
	const valuesSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		insert: () => db,
		values: (v: unknown) => {
			valuesSpy(v);
			return db;
		},
		limit: () => Promise.resolve(opts.throttleHit ? [{ id: "t" }] : []),
		returning: () => Promise.resolve(opts.inserted ?? []),
		then: (resolve: (v: unknown) => void) => resolve(opts.channels ?? []),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { valuesSpy };
}

const rule = (over: Record<string, unknown> = {}) => ({
	id: "r1",
	event_patterns: ["system.job.*"],
	match: {},
	severity: "info",
	throttle_seconds: 0,
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resolveOrgEntitlements).mockResolvedValue({ advancedAlerting: true } as never);
});

describe("emitAlertEvent — matching", () => {
	it("returns 0 (no DB) when the org has no enabled rules", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([] as never);
		expect(await emitAlertEvent("org-1", "system.job.succeeded", { title: "x" } as never)).toBe(0);
		expect(getServiceDb).not.toHaveBeenCalled();
	});

	it("returns 0 when no rule's pattern matches the event key", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([rule({ event_patterns: ["system.job.*"] })] as never);
		mockDb({ channels: [{ channel_id: "c1" }] });
		expect(await emitAlertEvent("org-1", "system.runner.online", { title: "x" } as never)).toBe(0);
	});

	it("returns 0 when the field-match rejects the context", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([
			rule({ match: { job_types: ["DEPLOY"] } }),
		] as never);
		mockDb({ channels: [{ channel_id: "c1" }] });
		const ctx = { title: "x", job_type: "PLAN" };
		expect(await emitAlertEvent("org-1", "system.job.succeeded", ctx as never)).toBe(0);
	});
});

describe("emitAlertEvent — authz.* open-core gate", () => {
	it("suppresses PDP-sourced events without the advancedAlerting entitlement", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([rule({ event_patterns: ["authz.*"] })] as never);
		vi.mocked(resolveOrgEntitlements).mockResolvedValue({ advancedAlerting: false } as never);
		mockDb({ channels: [{ channel_id: "c1" }], inserted: [{ id: "d1" }] });
		expect(await emitAlertEvent("org-1", "authz.project.create.denied", { title: "x" } as never)).toBe(0);
		expect(dispatchDeliveries).not.toHaveBeenCalled();
	});

	it("allows PDP events when entitled", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([rule({ event_patterns: ["authz.*"] })] as never);
		mockDb({ channels: [{ channel_id: "c1" }], inserted: [{ id: "d1" }] });
		expect(await emitAlertEvent("org-1", "authz.project.create.denied", { title: "x" } as never)).toBe(1);
	});
});

describe("emitAlertEvent — fan-out + throttle", () => {
	it("creates one pending delivery per bound channel and dispatches them", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([rule()] as never);
		const { valuesSpy } = mockDb({
			channels: [{ channel_id: "c1" }, { channel_id: "c2" }],
			inserted: [{ id: "d1" }, { id: "d2" }],
		});
		const n = await emitAlertEvent("org-1", "system.job.succeeded", { title: "x" } as never);
		expect(n).toBe(2);
		const rows = valuesSpy.mock.calls[0][0] as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			org_id: "org-1",
			rule_id: "r1",
			channel_id: "c1",
			event_key: "system.job.succeeded",
			status: "pending",
		});
		expect(rows[0].dedupe_key).toBe("r1:c1:system.job.succeeded:");
		expect(dispatchDeliveries).toHaveBeenCalledWith([{ id: "d1" }, { id: "d2" }]);
	});

	it("skips a channel that is within its throttle window (no insert)", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([rule({ throttle_seconds: 60 })] as never);
		const { valuesSpy } = mockDb({ channels: [{ channel_id: "c1" }], throttleHit: true });
		expect(await emitAlertEvent("org-1", "system.job.succeeded", { title: "x" } as never)).toBe(0);
		expect(valuesSpy).not.toHaveBeenCalled();
		expect(dispatchDeliveries).not.toHaveBeenCalled();
	});

	it("uses resource_id as the throttle subject in the dedupe key", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([rule()] as never);
		const { valuesSpy } = mockDb({ channels: [{ channel_id: "c1" }], inserted: [{ id: "d1" }] });
		await emitAlertEvent("org-1", "system.job.succeeded", { title: "x", resource_id: "res-9" } as never);
		const rows = valuesSpy.mock.calls[0][0] as Array<Record<string, unknown>>;
		expect(rows[0].dedupe_key).toBe("r1:c1:system.job.succeeded:res-9");
	});

	it("falls through the subject precedence (job_id, then connector_slug)", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([rule()] as never);
		const a = mockDb({ channels: [{ channel_id: "c1" }], inserted: [{ id: "d1" }] });
		await emitAlertEvent("org-1", "system.job.succeeded", { title: "x", job_id: "job-1" } as never);
		expect((a.valuesSpy.mock.calls[0][0] as Record<string, unknown>[])[0].dedupe_key).toBe(
			"r1:c1:system.job.succeeded:job-1",
		);
		const b = mockDb({ channels: [{ channel_id: "c1" }], inserted: [{ id: "d1" }] });
		await emitAlertEvent("org-1", "system.job.succeeded", { title: "x", connector_slug: "gh" } as never);
		expect((b.valuesSpy.mock.calls[0][0] as Record<string, unknown>[])[0].dedupe_key).toBe(
			"r1:c1:system.job.succeeded:gh",
		);
	});

	it("stamps the effective severity (context override wins over the rule's)", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([rule({ severity: "info" })] as never);
		const a = mockDb({ channels: [{ channel_id: "c1" }], inserted: [{ id: "d1" }] });
		await emitAlertEvent("org-1", "system.job.succeeded", { title: "x" } as never);
		expect((a.valuesSpy.mock.calls[0][0] as Record<string, unknown>[])[0].context).toMatchObject({
			severity: "info", // rule default
		});
		const b = mockDb({ channels: [{ channel_id: "c1" }], inserted: [{ id: "d1" }] });
		await emitAlertEvent("org-1", "system.job.succeeded", { title: "x", severity: "critical" } as never);
		expect((b.valuesSpy.mock.calls[0][0] as Record<string, unknown>[])[0].context).toMatchObject({
			severity: "critical", // context override
		});
	});
});

describe("emitAlertEventSafe / emitActionEvent (fire-and-forget seams)", () => {
	it("emitAlertEventSafe swallows a downstream failure (never throws)", async () => {
		vi.mocked(getEnabledRules).mockRejectedValue(new Error("boom"));
		expect(() =>
			emitAlertEventSafe("org-1", "system.job.succeeded", { title: "x" } as never),
		).not.toThrow();
		await new Promise((r) => setTimeout(r, 0)); // let the .catch run
	});

	it("emitActionEvent emits a PDP event against the actor's org", async () => {
		vi.mocked(getEnabledRules).mockResolvedValue([] as never);
		emitActionEvent(
			{ orgId: "org-1", userId: "u1" } as never,
			"create" as never,
			{ type: "project", id: "p1" } as never,
			false,
		);
		await new Promise((r) => setTimeout(r, 0));
		expect(getEnabledRules).toHaveBeenCalledWith("org-1");
	});
});
