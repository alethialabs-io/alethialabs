// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the alerts server actions. We stub the PDP/guard, the
// thenable drizzle chain, crypto, rate-limit, channel senders, and the rule cache —
// but keep the real catalog (eventMatches/isSecurityKey), the real zod validators,
// the real getEntitlements math and the real `defineAction` mapping, so the action logic
// itself is exercised and every outcome is read as the `ActionResult` the client receives
// (#6125). The hub's reads moved to lib/rpc/procedures/alerts.ts
// (tests/lib/rpc/alerts-procedures.test.ts).

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

import {
	addChannel,
	createPolicy,
	deleteChannel,
	deletePolicy,
	setChannelEnabled,
	togglePolicy,
	updateChannel,
	updatePolicy,
	verifyChannel,
} from "@/app/server/actions/alerts";
import { UnauthorizedError } from "@/lib/auth/errors";
import { getPdp } from "@/lib/authz";
import { authorize } from "@/lib/authz/guard";
import { getChannelSender } from "@/lib/alerts/channels";
import { invalidateOrgRules } from "@/lib/alerts/rule-cache";
import { encryptSecret, isCredEncryptionConfigured } from "@/lib/crypto/secrets";
import { getServiceDb } from "@/lib/db";
import { SsrfError } from "@/lib/net/ssrf-guard";
import { checkRateLimit } from "@/lib/rate-limit";

const UUID = "11111111-1111-4111-8111-111111111111";
/** A channel / rule id (the actions validate ids as uuids). */
const CH = "22222222-2222-4222-8222-222222222222";
const RULE = "33333333-3333-4333-8333-333333333333";

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
const pdpCan = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue(actor() as never);
	vi.mocked(getPdp).mockReturnValue({ enforce: pdpEnforce, can: pdpCan } as never);
	pdpEnforce.mockResolvedValue(undefined);
	pdpCan.mockResolvedValue({ allowed: true });
	vi.mocked(checkRateLimit).mockResolvedValue({ ok: true, remaining: 1 });
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
		transaction: (fn: (tx: unknown) => unknown) => fn(db),
		then: (resolve: (v: unknown) => void) => resolve(selectRows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { setSpy, valuesSpy, whereSpy };
}

describe("addChannel", () => {
	it("creates an email channel without touching encryption", async () => {
		const { valuesSpy } = mockDb({ returningRows: [{ id: "ch-new" }] });
		const res = await addChannel({
			type: "email",
			name: "Mail",
			enabled: true,
			recipients: ["x@y.com"],
		} as never);
		expect(res).toEqual({ ok: true, data: { added: true, id: "ch-new" } });
		expect(encryptSecret).not.toHaveBeenCalled();
		expect(valuesSpy.mock.calls[0][0]).toMatchObject({
			org_id: "org-1",
			type: "email",
			created_by: "user-1",
			secret: null,
		});
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
		// An answer the sheet renders inline — nothing was persisted.
		expect(res).toEqual({
			ok: true,
			data: { added: false, error: expect.stringContaining("Encryption is not configured") },
		});
	});

	it("a destination that does not verify is not created, and says why", async () => {
		const { valuesSpy } = mockDb({ returningRows: [{ id: "ch-x" }] });
		senderVerify.mockRejectedValue(new Error("fetch failed"));
		const res = await addChannel({
			type: "webhook",
			name: "Hook",
			enabled: true,
			secret: { url: "https://hooks.example.com/abc" },
		} as never);
		expect(res).toEqual({
			ok: true,
			data: { added: false, error: expect.stringMatching(/Couldn't reach the endpoint/) },
		});
		expect(valuesSpy).not.toHaveBeenCalled();
	});

	it("invalid input is a validation result keyed by field, not a thrown parse error", async () => {
		mockDb();
		const res = await addChannel({ type: "email", name: "", enabled: true, recipients: ["nope"] } as never);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.error.kind).toBe("validation");
		if (res.error.kind !== "validation") return;
		expect(Object.keys(res.error.fields)).toEqual(expect.arrayContaining(["name", "recipients.0"]));
	});

	it("returns an error when no destination is supplied", async () => {
		mockDb();
		const res = await addChannel({ type: "webhook", name: "S", enabled: true } as never);
		expect(res).toEqual({ ok: true, data: { added: false, error: expect.stringContaining("URL") } });
	});

	it("is an entitlement refusal when the org plan lacks alerting", async () => {
		vi.mocked(authorize).mockResolvedValue(
			actor({ entitlements: { alerting: false, advancedAlerting: false } }) as never,
		);
		mockDb();
		expect(
			await addChannel({ type: "email", name: "M", enabled: true, recipients: ["a@b.com"] } as never),
		).toEqual({
			ok: false,
			error: { kind: "entitlement", message: expect.stringMatching(/Pro plan/), feature: "alerting" },
		});
	});

	it("an unauthenticated guard rejection is the `unauthenticated` kind", async () => {
		vi.mocked(authorize).mockRejectedValue(new UnauthorizedError());
		expect(
			await addChannel({ type: "email", name: "M", enabled: true, recipients: ["a@b.com"] } as never),
		).toEqual({ ok: false, error: { kind: "unauthenticated" } });
	});
});

describe("updateChannel", () => {
	it("resets verification and omits the secret when none is supplied", async () => {
		const { setSpy } = mockDb({ returningRows: [{ id: CH }] });
		const res = await updateChannel({
			id: CH,
			type: "email",
			name: "M2",
			enabled: true,
			recipients: ["a@b.com"],
		} as never);
		expect(res).toEqual({ ok: true, data: { id: CH } });
		const written = setSpy.mock.calls[0][0];
		expect(written.is_verified).toBe(false);
		expect("secret" in written).toBe(false);
	});

	it("re-encrypts and writes the secret when new fields arrive", async () => {
		const { setSpy } = mockDb({ returningRows: [{ id: CH }] });
		await updateChannel({
			id: CH,
			type: "webhook",
			name: "H",
			enabled: true,
			secret: { url: "https://x.io/new" },
		} as never);
		expect(setSpy.mock.calls[0][0].secret).toEqual({ enc: "sealed" });
	});

	it("refuses (conflict) when a new secret is supplied but encryption is unconfigured", async () => {
		vi.mocked(isCredEncryptionConfigured).mockReturnValue(false);
		const { setSpy } = mockDb({ returningRows: [{ id: CH }] });
		expect(
			await updateChannel({ id: CH, type: "webhook", name: "H", enabled: true, secret: { url: "https://x.io/n" } } as never),
		).toEqual({ ok: false, error: { kind: "conflict", message: expect.stringMatching(/Encryption is not configured/) } });
		expect(setSpy).not.toHaveBeenCalled();
	});

	it("is NOT_FOUND when the org-bound update matched no row", async () => {
		mockDb({ returningRows: [] });
		expect(
			await updateChannel({ id: CH, type: "email", name: "M", enabled: true, recipients: ["a@b.com"] } as never),
		).toEqual({ ok: false, error: { kind: "not-found", message: "Channel not found." } });
	});
});

describe("channel toggles", () => {
	it("deleteChannel removes the row", async () => {
		const { whereSpy } = mockDb({ returningRows: [{ id: CH }] });
		expect(await deleteChannel({ id: CH })).toEqual({ ok: true, data: { id: CH } });
		expect(whereSpy).toHaveBeenCalled();
	});

	it("deleteChannel is NOT_FOUND when the org-bound delete matched no row", async () => {
		mockDb({ returningRows: [] });
		expect(await deleteChannel({ id: CH })).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Channel not found." },
		});
	});

	it("a non-uuid id is a validation result, and nothing is written", async () => {
		const { whereSpy } = mockDb({ returningRows: [{ id: CH }] });
		const res = await deleteChannel({ id: "ch-1" });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error.kind).toBe("validation");
		expect(whereSpy).not.toHaveBeenCalled();
	});

	it("setChannelEnabled toggles enabled without resetting verification", async () => {
		const { setSpy } = mockDb({ returningRows: [{ id: CH }] });
		await setChannelEnabled({ id: CH, enabled: false });
		const written = setSpy.mock.calls[0][0];
		expect(written.enabled).toBe(false);
		expect("is_verified" in written).toBe(false);
	});
});

describe("verifyChannel", () => {
	it("short-circuits when rate-limited", async () => {
		vi.mocked(checkRateLimit).mockResolvedValue({ ok: false, remaining: 0 });
		mockDb();
		expect(await verifyChannel({ id: CH })).toEqual({
			ok: true,
			data: { verified: false, error: expect.stringMatching(/Too many/) },
		});
		expect(getChannelSender).not.toHaveBeenCalled();
	});

	it("returns not-found when the channel row is missing", async () => {
		mockDb({ selectRows: [] });
		expect(await verifyChannel({ id: CH })).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Channel not found." },
		});
	});

	it("marks verified on a successful send", async () => {
		const { setSpy } = mockDb({ selectRows: [{ id: CH, type: "slack" }] });
		expect(await verifyChannel({ id: CH })).toEqual({ ok: true, data: { verified: true } });
		expect(senderVerify).toHaveBeenCalledWith({ id: CH, type: "slack" });
		expect(setSpy.mock.calls[0][0].is_verified).toBe(true);
	});

	it("a destination the outbound guard refuses gets one fixed sentence, never the guard's own words", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mockDb({ selectRows: [{ id: CH, type: "webhook" }] });
		senderVerify.mockRejectedValue(
			new SsrfError("Refusing to connect to non-public address 10.1.2.3 for host internal.example"),
		);
		const result = await verifyChannel({ id: CH });
		expect(result).toEqual({
			ok: true,
			data: { verified: false, error: "This destination isn't publicly reachable over HTTPS." },
		});
		expect(JSON.stringify(result)).not.toContain("10.1.2.3");
		warn.mockRestore();
	});

	it("maps a network failure to a friendly reachability message", async () => {
		const { setSpy } = mockDb({ selectRows: [{ id: CH, type: "webhook" }] });
		senderVerify.mockRejectedValue(new Error("fetch failed"));
		expect(await verifyChannel({ id: CH })).toEqual({
			ok: true,
			data: { verified: false, error: expect.stringMatching(/Couldn't reach the endpoint/) },
		});
		expect(setSpy).not.toHaveBeenCalled();
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

	it("inserts the rule, binds channels and invalidates the cache", async () => {
		const { valuesSpy } = mockDb({ selectRows: [{ id: UUID }], returningRows: [{ id: "rule-1" }] });
		expect(await createPolicy(base as never)).toEqual({ ok: true, data: { id: "rule-1" } });
		// First insert = rule values; second = channel bindings.
		expect(valuesSpy.mock.calls[0][0]).toMatchObject({ org_id: "org-1", name: "P", created_by: "user-1" });
		expect(valuesSpy.mock.calls[1][0]).toEqual([{ rule_id: "rule-1", channel_id: UUID, min_severity: null }]);
		expect(invalidateOrgRules).toHaveBeenCalledWith("org-1");
	});

	it("refuses authz.* patterns without the advancedAlerting entitlement", async () => {
		mockDb({ selectRows: [{ id: UUID }] });
		expect(await createPolicy({ ...base, event_patterns: ["authz.role.edit"] } as never)).toEqual({
			ok: false,
			error: { kind: "entitlement", message: expect.stringMatching(/Enterprise/), feature: "advancedAlerting" },
		});
	});

	it("refuses when a bound channel is not owned by the org", async () => {
		const { valuesSpy } = mockDb({ selectRows: [], returningRows: [{ id: "rule-1" }] }); // ownership lookup returns nothing
		expect(await createPolicy(base as never)).toEqual({
			ok: false,
			error: { kind: "not-found", message: "One or more channels are invalid." },
		});
		expect(valuesSpy).not.toHaveBeenCalled();
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
		const { setSpy, valuesSpy } = mockDb({
			selectRows: [{ id: UUID }],
			returningRows: [{ id: "rule-1" }],
		});
		expect(await updatePolicy({ ...base, id: RULE } as never)).toEqual({ ok: true, data: { id: "rule-1" } });
		expect(setSpy.mock.calls[0][0]).toMatchObject({ name: "P", event_patterns: ["system.job.failed"] });
		expect(valuesSpy.mock.calls[0][0]).toEqual([{ rule_id: "rule-1", channel_id: UUID, min_severity: null }]);
		expect(invalidateOrgRules).toHaveBeenCalledWith("org-1");
	});

	it("updatePolicy refuses a policy the org-bound update did not match, binding nothing", async () => {
		const { valuesSpy } = mockDb({ selectRows: [{ id: UUID }], returningRows: [] });
		expect(await updatePolicy({ ...base, id: RULE } as never)).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Alert policy not found." },
		});
		expect(valuesSpy).not.toHaveBeenCalled();
		expect(invalidateOrgRules).not.toHaveBeenCalled();
	});

	it("togglePolicy flips enabled and invalidates the cache", async () => {
		const { setSpy } = mockDb({ returningRows: [{ id: RULE }] });
		expect(await togglePolicy({ id: RULE, enabled: false })).toEqual({ ok: true, data: { id: RULE } });
		expect(setSpy.mock.calls[0][0].enabled).toBe(false);
		expect(invalidateOrgRules).toHaveBeenCalledWith("org-1");
	});

	it("togglePolicy is NOT_FOUND when the org-bound update matched no row", async () => {
		mockDb({ returningRows: [] });
		expect(await togglePolicy({ id: RULE, enabled: false })).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Alert policy not found." },
		});
		expect(invalidateOrgRules).not.toHaveBeenCalled();
	});

	it("deletePolicy removes the rule and invalidates the cache", async () => {
		const { whereSpy } = mockDb({ returningRows: [{ id: RULE }] });
		expect(await deletePolicy({ id: RULE })).toEqual({ ok: true, data: { id: RULE } });
		expect(whereSpy).toHaveBeenCalled();
		expect(invalidateOrgRules).toHaveBeenCalledWith("org-1");
	});

	it("deletePolicy is NOT_FOUND when the org-bound delete matched no row", async () => {
		mockDb({ returningRows: [] });
		expect(await deletePolicy({ id: RULE })).toEqual({
			ok: false,
			error: { kind: "not-found", message: "Alert policy not found." },
		});
		expect(invalidateOrgRules).not.toHaveBeenCalled();
	});
});
