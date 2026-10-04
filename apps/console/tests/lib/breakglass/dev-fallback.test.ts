// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// The BREAKGLASS_DEV_EMAIL fallback is refused in production (#5501).
//
// The fallback admits a request that carries NO credential: no bearer, no trusted proxy header.
// "Never set in production" used to be only a comment, so one stray variable in a production env
// file made the break-glass surface unauthenticated for every allowlisted address it named. The
// fallback is now refused whenever NODE_ENV=production, which the console's production images set.
//
// Only the account-id lookup is stubbed; the resolver and the config module are the real code.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getServiceDb } = vi.hoisted(() => ({ getServiceDb: vi.fn() }));

vi.mock("@/lib/db", () => ({ getServiceDb }));

import { resolveBreakglassOperator } from "@/lib/breakglass/auth";
import { breakglassDevEmail } from "@/lib/breakglass/config";

const DEV_EMAIL = "alice@x.io";
const DEV_USER_ID = "user-dev";

const ENV_KEYS = [
	"ALETHIA_BREAKGLASS_ENABLED",
	"BREAKGLASS_OPERATORS",
	"BREAKGLASS_DEV_EMAIL",
	"BREAKGLASS_ACCESS_PROXY_SECRET",
];
let saved: Record<string, string | undefined>;

/** A db stub whose `select().from().where().limit()` chain answers with the dev account's id. */
function stubDb() {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: async () => [{ id: DEV_USER_ID }],
	};
	getServiceDb.mockReturnValue(chain);
}

/** A request with no Authorization header and no proxy headers — the fallback's only input. */
function bareReq(): Request {
	return new Request("https://console.test/api/breakglass/whatever");
}

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.ALETHIA_BREAKGLASS_ENABLED = "true";
	process.env.BREAKGLASS_OPERATORS = DEV_EMAIL;
	process.env.BREAKGLASS_DEV_EMAIL = DEV_EMAIL;
	vi.clearAllMocks();
	stubDb();
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("BREAKGLASS_DEV_EMAIL fallback (#5501)", () => {
	it("is refused when NODE_ENV=production, even when allowlisted", async () => {
		vi.stubEnv("NODE_ENV", "production");
		expect(breakglassDevEmail()).toBeNull();
		expect(await resolveBreakglassOperator(bareReq())).toBeNull();
	});

	it("still admits an allowlisted dev email outside production", async () => {
		vi.stubEnv("NODE_ENV", "development");
		expect(breakglassDevEmail()).toBe(DEV_EMAIL);
		expect(await resolveBreakglassOperator(bareReq())).toEqual({
			email: DEV_EMAIL,
			userId: DEV_USER_ID,
		});
	});
});
