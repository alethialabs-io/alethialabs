// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The two CLI device-code routes. /generate is the account-takeover gate (it must refuse
// a device code that already belongs to someone else, and demand the RFC 8628 user_code);
// /exchange is the redemption gate (single-use via DELETE … RETURNING, expiry as 410, and
// the JWT-secret check before any DB work).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => ({
	auth: {
		api: {
			getSession: vi.fn(),
			listUserAccounts: vi.fn(),
			getAccessToken: vi.fn(),
		},
	},
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { POST as EXCHANGE } from "@/app/api/auth/cli/exchange/route";
import { POST as GENERATE } from "@/app/api/auth/cli/generate/route";
import { auth } from "@/lib/auth";
import { getServiceDb } from "@/lib/db";
import { headers } from "next/headers";

const HYG_CLI_AUTHFLOW_DEVICE_CODE = "2f1c8c1e-7a4b-4d2e-9a3f-0b5c6d7e8f90";
const HYG_CLI_AUTHFLOW_USER_CODE = "BCDF-GHJK";

/**
 * A drizzle-ish chain whose builders return the chain and whose every `await` resolves to
 * the next seeded result-set (FIFO), so each sequential query gets its own rows. Records
 * which terminal builders were called so single-use/atomicity can be asserted.
 */
function hygCliAuthflowDb() {
	const queue: unknown[][] = [];
	const calls = {
		delete: vi.fn(),
		returning: vi.fn(),
		insert: vi.fn(),
		values: vi.fn(),
		onConflictDoUpdate: vi.fn(),
	};
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => db,
		leftJoin: () => db,
		delete: (...a: unknown[]) => {
			calls.delete(...a);
			return db;
		},
		returning: (...a: unknown[]) => {
			calls.returning(...a);
			return db;
		},
		insert: (...a: unknown[]) => {
			calls.insert(...a);
			return db;
		},
		values: (...a: unknown[]) => {
			calls.values(...a);
			return db;
		},
		onConflictDoUpdate: (...a: unknown[]) => {
			calls.onConflictDoUpdate(...a);
			return db;
		},
		then: (resolve: (v: unknown) => void) =>
			resolve(queue.length ? queue.shift() : []),
	});
	return { db, queue, calls };
}

let hygDb: ReturnType<typeof hygCliAuthflowDb>;

/** A POST Request carrying `body`, optionally with a trusted client IP. */
function hygCliAuthflowRequest(
	path: string,
	body: unknown,
	init: Record<string, string> = {},
): Request {
	return new Request(`https://console.local${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...init },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	hygDb = hygCliAuthflowDb();
	vi.mocked(getServiceDb).mockReturnValue(hygDb.db as never);
	vi.mocked(headers).mockResolvedValue(new Headers() as never);
	vi.mocked(auth.api.getSession).mockResolvedValue({
		user: { id: "victim" },
	} as never);
	vi.mocked(auth.api.listUserAccounts).mockResolvedValue([] as never);
	process.env.CLI_JWT_SECRET = "test-cli-jwt-secret";
});

describe("POST /api/auth/cli/generate", () => {
	it("approves an unclaimed device code and writes an expiry", () => {
		hygDb.queue.push(
			[], // no existing row
			[], // the upsert itself
			[{ profile_id: "victim" }], // post-write ownership confirmation
		);
		return GENERATE(
			hygCliAuthflowRequest("/api/auth/cli/generate", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
				user_code: HYG_CLI_AUTHFLOW_USER_CODE,
			}),
		).then(async (res) => {
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ success: true });

			const values = hygDb.calls.values.mock.calls[0]?.[0] as {
				expires_at?: Date;
			};
			expect(values.expires_at).toBeInstanceOf(Date);
			expect(values.expires_at!.getTime()).toBeGreaterThan(Date.now());

			// expires_at must be in the conflict update too: without it a returning user
			// re-approving the same code keeps their original, stale deadline.
			const conflict = hygDb.calls.onConflictDoUpdate.mock.calls[0]?.[0] as {
				set: Record<string, unknown>;
			};
			expect(conflict.set).toHaveProperty("expires_at");
			expect(conflict.set.expires_at).toBeInstanceOf(Date);
		});
	});

	// Better Auth 1.7 changed what `accountId` MEANS: it is the local account row id now, where
	// 1.6 matched the provider-side identifier. Passing the wrong one does not error at the
	// boundary — it matches nothing, and the CLI silently ships without a git token. Pin the
	// selector so that swap cannot happen unnoticed.
	it("selects the git account by its LOCAL account.id, not by providerId", async () => {
		vi.mocked(auth.api.listUserAccounts).mockResolvedValue([
			{ id: "acct-row-9", providerId: "github", accountId: "gh-provider-side-42" },
		] as never);
		vi.mocked(auth.api.getAccessToken).mockResolvedValue({
			accessToken: "ghp_from_row_9",
		} as never);
		hygDb.queue.push([], [], [{ profile_id: "victim" }]);

		const res = await GENERATE(
			hygCliAuthflowRequest("/api/auth/cli/generate", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
				user_code: HYG_CLI_AUTHFLOW_USER_CODE,
			}),
		);

		expect(res.status).toBe(200);
		const call = vi.mocked(auth.api.getAccessToken).mock.calls[0]?.[0] as {
			body: Record<string, unknown>;
		};
		expect(call.body.accountId).toBe("acct-row-9");
		// The provider-side id is what 1.6 would have sent. It must not appear at all, and
		// `providerId` is now rejected outright by a strict object.
		expect(call.body.accountId).not.toBe("gh-provider-side-42");
		expect(call.body).not.toHaveProperty("providerId");
	});

	it("refuses a device code already bound to another account", async () => {
		// The account takeover: the attacker's device code, opened by a signed-in victim.
		hygDb.queue.push([{ profile_id: "attacker" }]);

		const res = await GENERATE(
			hygCliAuthflowRequest("/api/auth/cli/generate", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
				user_code: HYG_CLI_AUTHFLOW_USER_CODE,
			}),
		);

		expect(res.status).toBe(409);
		// Nothing may be written: the row must keep pointing at its original owner.
		expect(hygDb.calls.insert).not.toHaveBeenCalled();
	});

	it("refuses when the conditional upsert did not take the row", async () => {
		// The SELECT-then-write race: the row was claimed between the two statements, so
		// setWhere matched nothing and the update was a silent no-op.
		hygDb.queue.push(
			[], // no existing row at SELECT time
			[], // the upsert
			[], // ownership confirmation finds nothing that is ours
		);

		const res = await GENERATE(
			hygCliAuthflowRequest("/api/auth/cli/generate", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
				user_code: HYG_CLI_AUTHFLOW_USER_CODE,
			}),
		);

		expect(res.status).toBe(409);
	});

	it("requires the RFC 8628 user_code", async () => {
		const res = await GENERATE(
			hygCliAuthflowRequest("/api/auth/cli/generate", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
			}),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toContain("user_code");
		expect(hygDb.calls.insert).not.toHaveBeenCalled();
	});

	it("rejects a device_code that is not UUID-shaped", async () => {
		const res = await GENERATE(
			hygCliAuthflowRequest("/api/auth/cli/generate", {
				device_code: "guessable",
				user_code: HYG_CLI_AUTHFLOW_USER_CODE,
			}),
		);
		expect(res.status).toBe(400);
	});

	it("still requires a session", async () => {
		vi.mocked(auth.api.getSession).mockResolvedValue(null as never);
		const res = await GENERATE(
			hygCliAuthflowRequest("/api/auth/cli/generate", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
				user_code: HYG_CLI_AUTHFLOW_USER_CODE,
			}),
		);
		expect(res.status).toBe(401);
	});
});

describe("POST /api/auth/cli/exchange", () => {
	/** Seeds a claimed row plus its profile lookup. */
	function hygCliAuthflowApproved(overrides: Record<string, unknown> = {}) {
		hygDb.queue.push(
			[
				{
					profile_id: "victim",
					verification_code: "gho_provider_token",
					expires_at: new Date(Date.now() + 60_000),
					created_at: new Date(),
					...overrides,
				},
			],
			[{ email: "ada@example.com" }],
		);
	}

	it("mints a token pair for an approved, unexpired code", async () => {
		hygCliAuthflowApproved();
		const res = await EXCHANGE(
			hygCliAuthflowRequest("/api/auth/cli/exchange", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.access_token).toBeTruthy();
		expect(body.refresh_token).toBeTruthy();
		expect(body.user_email).toBe("ada@example.com");
	});

	it("claims the row with a single atomic DELETE … RETURNING", async () => {
		// The old route did select-then-delete, so two concurrent polls both read the row
		// and BOTH minted a full token pair.
		hygCliAuthflowApproved();
		await EXCHANGE(
			hygCliAuthflowRequest("/api/auth/cli/exchange", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
			}),
		);
		expect(hygDb.calls.delete).toHaveBeenCalledTimes(1);
		expect(hygDb.calls.returning).toHaveBeenCalledTimes(1);
	});

	it("answers 410 — not 404 — for an expired code", async () => {
		// 404 is the CLI's "still pending" status; returning it here would make the poller
		// spin forever on a code that can never work.
		hygCliAuthflowApproved({
			expires_at: new Date(Date.now() - 1),
			created_at: new Date(Date.now() - 3_600_000),
		});
		const res = await EXCHANGE(
			hygCliAuthflowRequest("/api/auth/cli/exchange", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
			}),
		);
		expect(res.status).toBe(410);
		expect((await res.json()).error).toContain("expired");
	});

	it("answers 410 for a legacy row whose expires_at is NULL but whose created_at is old", async () => {
		hygCliAuthflowApproved({
			expires_at: null,
			created_at: new Date(Date.now() - 24 * 3_600_000),
		});
		const res = await EXCHANGE(
			hygCliAuthflowRequest("/api/auth/cli/exchange", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
			}),
		);
		expect(res.status).toBe(410);
	});

	it("still answers 404 while the browser half is pending", async () => {
		hygDb.queue.push([]);
		const res = await EXCHANGE(
			hygCliAuthflowRequest("/api/auth/cli/exchange", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
			}),
		);
		expect(res.status).toBe(404);
	});

	it("checks CLI_JWT_SECRET before touching the database", async () => {
		delete process.env.CLI_JWT_SECRET;
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		hygCliAuthflowApproved();

		const res = await EXCHANGE(
			hygCliAuthflowRequest("/api/auth/cli/exchange", {
				device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
			}),
		);

		expect(res.status).toBe(500);
		// The row must survive: consuming it and then 500-ing left the user with a dead
		// code and no explanation.
		expect(hygDb.calls.delete).not.toHaveBeenCalled();
		err.mockRestore();
	});

	it("throttles a flood from one trusted IP and keeps a different IP unaffected", async () => {
		const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
		let throttled = 0;
		for (let i = 0; i < 400; i++) {
			hygDb.queue.push([]);
			const res = await EXCHANGE(
				hygCliAuthflowRequest(
					"/api/auth/cli/exchange",
					{ device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE },
					{ "cf-connecting-ip": ip },
				),
			);
			if (res.status === 429) throttled++;
		}
		expect(throttled).toBeGreaterThan(0);

		// A different IP has its own bucket.
		hygDb.queue.push([]);
		const other = await EXCHANGE(
			hygCliAuthflowRequest(
				"/api/auth/cli/exchange",
				{ device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE },
				{ "cf-connecting-ip": "198.51.100.254" },
			),
		);
		expect(other.status).toBe(404);
	});

	it("does not throttle when there is no trusted IP header (fail open)", async () => {
		// A self-host with no edge proxy would otherwise put every user in one bucket.
		for (let i = 0; i < 400; i++) {
			hygDb.queue.push([]);
			const res = await EXCHANGE(
				hygCliAuthflowRequest("/api/auth/cli/exchange", {
					device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
				}),
			);
			expect(res.status).toBe(404);
		}
	});
});
