// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the alerts server actions. We stub the PDP/guard, the
// thenable drizzle chain, crypto, rate-limit, channel senders, and the rule cache —
// but keep the real catalog (eventMatches/isSecurityKey), the real zod validators,
// and the real getEntitlements math, so the action logic itself is exercised.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/crypto/secrets", () => ({
	encryptSecret: vi.fn(),
	isCredEncryptionConfigured: vi.fn(),
}));
vi.mock("@/lib/alerts/channels", () => ({ getChannelSender: vi.fn() }));
vi.mock("@/lib/alerts/rule-cache", () => ({ invalidateOrgRules: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
	addChannel,
	createPolicy,
	deleteChannel,
	deletePolicy,
	getAlertsBootstrap,
	setChannelEnabled,
	togglePolicy,
	updateChannel,
	updatePolicy,
	verifyChannel,
} from "@/app/server/actions/alerts";
import { getPdp } from "@/lib/authz";
import { authorize } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { getChannelSender } from "@/lib/alerts/channels";
import { invalidateOrgRules } from "@/lib/alerts/rule-cache";
import { ALL_EVENTS } from "@/lib/alerts/catalog";
import { encryptSecret, isCredEncryptionConfigured } from "@/lib/crypto/secrets";
import { getServiceDb } from "@/lib/db";
import { alertChannels, alertDeliveries, alertRules } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";
import { revalidatePath } from "next/cache";

const UUID = "11111111-1111-4111-8111-111111111111";

/** Actor returned by the mocked guard; entitlements drive plan gating. */
function actor(over: Record<string, unknown> = {}) {
	return {
		orgId: "org-1",
		userId: "user-1",
		entitlements: { alerting: true, advancedAlerting: false },
		...over,
	};
}

const senderVerify = vi.fn();
const pdpEnforce = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue(actor() as never);
	vi.mocked(getPdp).mockReturnValue({ enforce: pdpEnforce } as never);
	pdpEnforce.mockResolvedValue(undefined);
	vi.mocked(checkRateLimit).mockReturnValue({ ok: true } as never);
	vi.mocked(isCredEncryptionConfigured).mockReturnValue(true);
	vi.mocked(encryptSecret).mockReturnValue({ enc: "sealed" } as never);
	vi.mocked(getChannelSender).mockReturnValue({ verify: senderVerify } as never);
	senderVerify.mockResolvedValue(undefined);
});

/**
 * Drizzle chain for the mutation actions: every builder returns itself, `await`
 * resolves to `selectRows`, `.returning()` resolves to `returningRows`, and
 * `.set()`/`.values()`/`.where()` are captured.
 */
function mockDb(
	{ selectRows = [], returningRows = [] }: { selectRows?: unknown[]; returningRows?: unknown[] } = {},
) {
	const setSpy = vi.fn();
	const valuesSpy = vi.fn();
	const whereSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		insert: () => db,
		update: () => db,
		delete: () => db,
		from: () => db,
		where: (...a: unknown[]) => {
			whereSpy(...a);
			return db;
		},
		orderBy: () => db,
		limit: () => db,
		innerJoin: () => db,
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		values: (...a: unknown[]) => {
			valuesSpy(...a);
			return db;
		},
		returning: () => returningRows,
		then: (resolve: (v: unknown) => void) => resolve(selectRows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { setSpy, valuesSpy, whereSpy };
}

/**
 * Drizzle chain for getAlertsBootstrap: each `.select()` is a fresh builder that
 * resolves (via `.then`) to the right seeded set, keyed by the select argument
 * (count query), whether a join ran (bindings), and the table reference.
 */
function mockBootstrapDb(seed: {
	channels: unknown[];
	rules: unknown[];
	bindings: unknown[];
	deliveries: unknown[];
	routed: unknown[];
}) {
	const db = {
		select(arg?: Record<string, unknown>) {
			let table: unknown = null;
			let joined = false;
			const b: Record<string, unknown> = {};
			Object.assign(b, {
				from: (t: unknown) => {
					table = t;
					return b;
				},
				innerJoin: () => {
					joined = true;
					return b;
				},
				where: () => b,
				orderBy: () => b,
				limit: () => b,
				then: (resolve: (v: unknown) => void) => {
					if (arg && "c" in arg) return resolve(seed.routed);
					if (joined) return resolve(seed.bindings);
					if (table === alertChannels) return resolve(seed.channels);
					if (table === alertRules) return resolve(seed.rules);
					if (table === alertDeliveries) return resolve(seed.deliveries);
					return resolve([]);
				},
			});
			return b;
		},
	};
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

describe("getAlertsBootstrap", () => {
	it("assembles channel/policy/delivery DTOs, derives coverage + stats, and reflects caller capability", async () => {
		vi.mocked(authorize).mockResolvedValue(
			actor({ entitlements: { alerting: true, advancedAlerting: true } }) as never,
		);
		mockBootstrapDb({
			channels: [
				{
					id: "ch-1",
					type: "slack",
					name: "Ops",
					enabled: true,
					is_verified: true,
					config: { recipients: ["a@b.com"] },
					secret: { enc: "x" },
					last_verified_at: null,
					archived_at: null,
					created_at: new Date(),
				},
			],
			rules: [
				{
					id: "rule-1",
					name: "Deploy fails",
					description: "d",
					event_patterns: ["system.job.failed"],
					severity: "critical",
					match: {},
					throttle_seconds: 0,
					escalate: false,
					recipient: null,
					enabled: true,
					created_at: new Date(),
				},
			],
			bindings: [{ alert_rule_channels: { rule_id: "rule-1", channel_id: "ch-1" } }],
			deliveries: [
				{
					id: "d-1",
					event_key: "system.job.failed",
					status: "sent",
					context: { title: "Deploy failed" },
					attempts: 1,
					last_error: null,
					created_at: new Date(),
					sent_at: new Date(),
				},
			],
			routed: [{ c: 7 }],
		});

		const r = await getAlertsBootstrap();

		expect(vi.mocked(authorize)).toHaveBeenCalledWith("view_alerts", { type: "alert" });
		// Channel DTO: secret never leaks; has_secret reflects its presence.
		expect(r.channels[0]).toMatchObject({ id: "ch-1", has_secret: true, recipients: ["a@b.com"] });
		expect("secret" in r.channels[0]).toBe(false);
		// Policy DTO: channelIds joined from bindings; non-authz key → not security.
		expect(r.policies[0].channelIds).toEqual(["ch-1"]);
		expect(r.policies[0].is_security).toBe(false);
		// Coverage uses the real catalog: only "system.job.failed" matches its key.
		expect(r.stats.eventsCovered).toBe(1);
		expect(r.stats.totalEvents).toBe(ALL_EVENTS.length);
		expect(r.stats.routed24h).toBe(7);
		expect(r.stats.enabled).toBe(1);
		expect(r.deliveries[0].title).toBe("Deploy failed");
		expect(r.alerting).toBe(true);
		expect(r.advancedAlerting).toBe(true);
		expect(r.canManage).toBe(true);
		expect(r.encryptionConfigured).toBe(true);
	});

	it("reports canManage=false when the PDP forbids manage_alerts", async () => {
		pdpEnforce.mockRejectedValue(new ForbiddenError("manage_alerts" as never, { type: "alert" }));
		mockBootstrapDb({ channels: [], rules: [], bindings: [], deliveries: [], routed: [] });
		const r = await getAlertsBootstrap();
		expect(r.canManage).toBe(false);
		expect(r.stats.routed24h).toBe(0); // empty count rows → fallback 0
	});
});

describe("addChannel", () => {
	it("creates an email channel without touching encryption and revalidates", async () => {
		const { valuesSpy } = mockDb({ returningRows: [{ id: "ch-new" }] });
		const res = await addChannel({
			type: "email",
			name: "Mail",
			enabled: true,
			recipients: ["x@y.com"],
		} as never);
		expect(res).toEqual({ ok: true, id: "ch-new" });
		expect(encryptSecret).not.toHaveBeenCalled();
		expect(valuesSpy.mock.calls[0][0]).toMatchObject({
			org_id: "org-1",
			type: "email",
			created_by: "user-1",
			secret: null,
		});
		expect(revalidatePath).toHaveBeenCalledWith("/dashboard/alerts");
	});

	it("encrypts the secret for a webhook channel and stores the envelope", async () => {
		const { valuesSpy } = mockDb({ returningRows: [{ id: "ch-w" }] });
		await addChannel({
			type: "webhook",
			name: "Hook",
			enabled: true,
			secret: { url: "https://hooks.example.com/abc" },
		} as never);
		expect(encryptSecret).toHaveBeenCalledWith({ url: "https://hooks.example.com/abc" });
		expect(valuesSpy.mock.calls[0][0].secret).toEqual({ enc: "sealed" });
	});

	it("returns a guidance error when a secret channel is created without an encryption key", async () => {
		vi.mocked(isCredEncryptionConfigured).mockReturnValue(false);
		mockDb();
		const res = await addChannel({
			type: "slack",
			name: "S",
			enabled: true,
			secret: { url: "https://x.io/h" },
		} as never);
		expect(res).toMatchObject({ ok: false });
	});

	it("returns an error when no destination is supplied", async () => {
		mockDb();
		const res = await addChannel({ type: "webhook", name: "S", enabled: true } as never);
		expect(res).toEqual({ ok: false, error: expect.stringContaining("URL") });
	});

	it("rejects when the org plan lacks alerting", async () => {
		vi.mocked(authorize).mockResolvedValue(
			actor({ entitlements: { alerting: false, advancedAlerting: false } }) as never,
		);
		mockDb();
		await expect(
			addChannel({ type: "email", name: "M", enabled: true, recipients: ["a@b.com"] } as never),
		).rejects.toThrow(/Pro plan/);
	});

	it("propagates an unauthorized guard rejection", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("Unauthorized"));
		await expect(
			addChannel({ type: "email", name: "M", enabled: true, recipients: ["a@b.com"] } as never),
		).rejects.toThrow(/Unauthorized/);
	});
});

describe("updateChannel", () => {
	it("resets verification and omits the secret when none is supplied", async () => {
		const { setSpy } = mockDb();
		await updateChannel("ch-1", {
			type: "email",
			name: "M2",
			enabled: true,
			recipients: ["a@b.com"],
		} as never);
		const written = setSpy.mock.calls[0][0];
		expect(written.is_verified).toBe(false);
		expect("secret" in written).toBe(false);
		expect(revalidatePath).toHaveBeenCalledWith("/dashboard/alerts");
	});

	it("re-encrypts and writes the secret when new fields arrive", async () => {
		const { setSpy } = mockDb();
		await updateChannel("ch-1", {
			type: "webhook",
			name: "H",
			enabled: true,
			secret: { url: "https://x.io/new" },
		} as never);
		expect(setSpy.mock.calls[0][0].secret).toEqual({ enc: "sealed" });
	});

	it("throws when a new secret is supplied but encryption is unconfigured", async () => {
		vi.mocked(isCredEncryptionConfigured).mockReturnValue(false);
		mockDb();
		await expect(
			updateChannel("ch-1", { type: "webhook", name: "H", enabled: true, secret: { url: "https://x.io/n" } } as never),
		).rejects.toThrow(/Encryption is not configured/);
	});
});

describe("channel toggles", () => {
	it("deleteChannel removes the row and revalidates", async () => {
		const { whereSpy } = mockDb();
		await deleteChannel("ch-1");
		expect(whereSpy).toHaveBeenCalled();
		expect(revalidatePath).toHaveBeenCalledWith("/dashboard/alerts");
	});

	it("setChannelEnabled toggles enabled without resetting verification", async () => {
		const { setSpy } = mockDb();
		await setChannelEnabled("ch-1", false);
		const written = setSpy.mock.calls[0][0];
		expect(written.enabled).toBe(false);
		expect("is_verified" in written).toBe(false);
	});
});

describe("verifyChannel", () => {
	it("short-circuits when rate-limited", async () => {
		vi.mocked(checkRateLimit).mockReturnValue({ ok: false } as never);
		mockDb();
		const r = await verifyChannel("ch-1");
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/Too many/);
		expect(getChannelSender).not.toHaveBeenCalled();
	});

	it("returns not-found when the channel row is missing", async () => {
		mockDb({ selectRows: [] });
		expect(await verifyChannel("ch-1")).toEqual({ ok: false, error: "Channel not found." });
	});

	it("marks verified on a successful send", async () => {
		const { setSpy } = mockDb({ selectRows: [{ id: "ch-1", type: "slack" }] });
		const r = await verifyChannel("ch-1");
		expect(r).toEqual({ ok: true });
		expect(senderVerify).toHaveBeenCalledWith({ id: "ch-1", type: "slack" });
		expect(setSpy.mock.calls[0][0].is_verified).toBe(true);
	});

	it("maps a network failure to a friendly reachability message", async () => {
		mockDb({ selectRows: [{ id: "ch-1", type: "webhook" }] });
		senderVerify.mockRejectedValue(new Error("fetch failed"));
		const r = await verifyChannel("ch-1");
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/Couldn't reach the endpoint/);
	});
});

describe("createPolicy", () => {
	const base = {
		name: "P",
		event_patterns: ["system.job.failed"],
		match: {},
		severity: "warning",
		throttle_seconds: 0,
		escalate: false,
		enabled: true,
		channels: [{ id: UUID }],
	};

	it("inserts the rule, binds channels, invalidates the cache and revalidates", async () => {
		const { valuesSpy } = mockDb({ selectRows: [{ id: UUID }], returningRows: [{ id: "rule-1" }] });
		await createPolicy(base as never);
		// First insert = rule values; second = channel bindings.
		expect(valuesSpy.mock.calls[0][0]).toMatchObject({ org_id: "org-1", name: "P", created_by: "user-1" });
		expect(valuesSpy.mock.calls[1][0]).toEqual([{ rule_id: "rule-1", channel_id: UUID, min_severity: null }]);
		expect(invalidateOrgRules).toHaveBeenCalledWith("org-1");
		expect(revalidatePath).toHaveBeenCalledWith("/dashboard/alerts");
	});

	it("rejects authz.* patterns without the advancedAlerting entitlement", async () => {
		mockDb({ selectRows: [{ id: UUID }] });
		await expect(
			createPolicy({ ...base, event_patterns: ["authz.role.edit"] } as never),
		).rejects.toThrow(/Enterprise/);
	});

	it("rejects when a bound channel is not owned by the org", async () => {
		mockDb({ selectRows: [], returningRows: [{ id: "rule-1" }] }); // ownership lookup returns nothing
		await expect(createPolicy(base as never)).rejects.toThrow(/channels are invalid/);
		expect(invalidateOrgRules).not.toHaveBeenCalled();
	});

	it("allows authz.* patterns when advancedAlerting is enabled", async () => {
		vi.mocked(authorize).mockResolvedValue(
			actor({ entitlements: { alerting: true, advancedAlerting: true } }) as never,
		);
		const { valuesSpy } = mockDb({ selectRows: [{ id: UUID }], returningRows: [{ id: "rule-2" }] });
		await createPolicy({ ...base, event_patterns: ["authz.role.edit"] } as never);
		expect(valuesSpy.mock.calls[0][0].event_patterns).toEqual(["authz.role.edit"]);
	});
});

describe("updatePolicy / togglePolicy / deletePolicy", () => {
	const base = {
		name: "P",
		event_patterns: ["system.job.failed"],
		match: {},
		severity: "warning",
		throttle_seconds: 0,
		escalate: false,
		enabled: true,
		channels: [{ id: UUID }],
	};

	it("updatePolicy rewrites the rule and replaces its bindings", async () => {
		const { setSpy, valuesSpy } = mockDb({ selectRows: [{ id: UUID }] });
		await updatePolicy("rule-1", base as never);
		expect(setSpy.mock.calls[0][0]).toMatchObject({ name: "P", event_patterns: ["system.job.failed"] });
		expect(valuesSpy.mock.calls[0][0]).toEqual([{ rule_id: "rule-1", channel_id: UUID, min_severity: null }]);
		expect(invalidateOrgRules).toHaveBeenCalledWith("org-1");
	});

	it("togglePolicy flips enabled and invalidates the cache", async () => {
		const { setSpy } = mockDb();
		await togglePolicy("rule-1", false);
		expect(setSpy.mock.calls[0][0].enabled).toBe(false);
		expect(invalidateOrgRules).toHaveBeenCalledWith("org-1");
	});

	it("deletePolicy removes the rule and invalidates the cache", async () => {
		const { whereSpy } = mockDb();
		await deletePolicy("rule-1");
		expect(whereSpy).toHaveBeenCalled();
		expect(invalidateOrgRules).toHaveBeenCalledWith("org-1");
		expect(revalidatePath).toHaveBeenCalledWith("/dashboard/alerts");
	});
});
