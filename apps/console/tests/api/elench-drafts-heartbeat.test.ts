// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The guard of POST /api/elench/drafts/heartbeat (ADR 0001 §3.4 S7, B1): session, zod, the rate
// limit, `resolveTurnActor`, then one `withActorScope` transaction. The transaction's own SQL (the
// token-matched renewal on the caller's own row, and that it never settles) is tested against the
// fake database in tests/actions/elench-draft-claims.test.ts; here `touchClaim` is a spy, so each
// test can say exactly what reached it, and with which actor.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn(), getOwnerScope: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({
	resolveTurnActor: vi.fn(),
	currentActor: vi.fn(),
	authorizeQuiet: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/elench/draft-claims", () => ({ touchClaim: vi.fn() }));

import { POST } from "@/app/api/elench/drafts/heartbeat/route";
import { getOwner } from "@/lib/auth/owner";
import { resolveTurnActor } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { touchClaim } from "@/lib/elench/draft-claims";
import { checkRateLimit } from "@/lib/rate-limit";

const USER = "00000000-0000-4000-8000-000000000001";
const TEAMMATE = "00000000-0000-4000-8000-000000000002";
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000b1";
const CONV = "00000000-0000-4000-8000-0000000c0001";
const TOKEN = "00000000-0000-4000-8000-0000000e0001";
const TX = { fake: "tx" };

/** POSTs `body` (JSON-encoded unless it is already a string) to the heartbeat. */
const beat = (body: unknown) =>
	POST(
		new Request("http://localhost/api/elench/drafts/heartbeat", {
			method: "POST",
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);

const valid = { orgId: ORG_A, conversationId: CONV, token: TOKEN };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getOwner).mockResolvedValue(USER);
	vi.mocked(checkRateLimit).mockResolvedValue({ ok: true, remaining: 19 });
	vi.mocked(resolveTurnActor).mockImplementation(async (userId, orgId) =>
		orgId === ORG_A ? { userId, orgId } : null,
	);
	vi.mocked(touchClaim).mockResolvedValue({ outcome: "touched" });
	// The transaction is a token object: only touchClaim (a spy) ever receives it.
	vi.mocked(withActorScope).mockImplementation(
		((_actor: unknown, fn: (tx: unknown) => unknown) => fn(TX)) as never,
	);
});

describe("POST /api/elench/drafts/heartbeat", () => {
	it("renews through touchClaim as the resolved actor, and answers its outcome", async () => {
		const res = await beat(valid);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ outcome: "touched" });
		expect(resolveTurnActor).toHaveBeenCalledWith(USER, ORG_A);
		expect(withActorScope).toHaveBeenCalledWith({ userId: USER, orgId: ORG_A }, expect.any(Function));
		expect(touchClaim).toHaveBeenCalledWith(TX, { userId: USER, orgId: ORG_A }, CONV, TOKEN);
	});

	it("takes the user from the session, never from the body", async () => {
		await beat({ ...valid, userId: TEAMMATE });
		expect(resolveTurnActor).toHaveBeenCalledWith(USER, ORG_A);
		expect(vi.mocked(touchClaim).mock.calls[0]?.[1]).toEqual({ userId: USER, orgId: ORG_A });
	});

	it("is 401 without a session, and reads nothing else", async () => {
		vi.mocked(getOwner).mockResolvedValue(null);
		expect((await beat(valid)).status).toBe(401);
		expect(checkRateLimit).not.toHaveBeenCalled();
		expect(resolveTurnActor).not.toHaveBeenCalled();
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("is 400 for a body that is not the schema's, and renews nothing", async () => {
		for (const body of ["not json", { ...valid, token: "abc" }, { orgId: ORG_A, conversationId: CONV }, null]) {
			expect((await beat(body)).status).toBe(400);
		}
		expect(withActorScope).not.toHaveBeenCalled();
		expect(resolveTurnActor).not.toHaveBeenCalled();
	});

	it("is 429 over the per-user rate, in the draft actions' bucket, and renews nothing", async () => {
		vi.mocked(checkRateLimit).mockResolvedValue({ ok: false, remaining: 0 });
		expect((await beat(valid)).status).toBe(429);
		expect(checkRateLimit).toHaveBeenCalledWith(`elench-drafts:${USER}`, 20, 1000);
		expect(resolveTurnActor).not.toHaveBeenCalled();
		expect(withActorScope).not.toHaveBeenCalled();
	});

	it("the heartbeat route refuses an org the caller is not an active member of with 403 and renews nothing", async () => {
		const res = await beat({ ...valid, orgId: ORG_B });
		expect(res.status).toBe(403);
		expect(resolveTurnActor).toHaveBeenCalledWith(USER, ORG_B);
		expect(withActorScope).not.toHaveBeenCalled();
		expect(touchClaim).not.toHaveBeenCalled();
	});

	it("a database error is 503 and logs no parameter; any other throw propagates", async () => {
		const driver = Object.assign(new Error(`params: ${TOKEN}`), { code: "ECONNREFUSED" });
		vi.mocked(withActorScope).mockRejectedValueOnce(
			Object.assign(new Error("Failed query"), { name: "DrizzleQueryError", cause: driver }),
		);
		const res = await beat(valid);
		expect(res.status).toBe(503);
		expect(await res.text()).not.toContain(TOKEN);
		vi.mocked(withActorScope).mockRejectedValueOnce(new TypeError("boom"));
		await expect(beat(valid)).rejects.toThrow("boom");
	});
});
