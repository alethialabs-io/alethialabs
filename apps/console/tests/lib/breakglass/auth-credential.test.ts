// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// Which CLI credential may carry the break-glass identity (#5496).
//
// `verifyCliToken` accepts two bearer kinds and maps both to a user id: an interactive session JWT
// (device login) carries the user directly, and a service token carries the user who MINTED it. A
// service token is pinned to one org and is handed to that tenant's CI; break-glass is
// platform-wide. So a service token minted by an allowlisted operator must be refused, while that
// operator's own session JWT is accepted.
//
// The real `verifyCliToken` runs here: only the service-token row lookup and the account-email
// lookup are stubbed, so the prefix routing and the JWT verification are the production code.

import * as jose from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveServiceToken, getServiceDb } = vi.hoisted(() => ({
	resolveServiceToken: vi.fn(),
	getServiceDb: vi.fn(),
}));

vi.mock("@/lib/cli/service-token", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cli/service-token")>();
	return { ...actual, resolveServiceToken };
});

vi.mock("@/lib/db", () => ({ getServiceDb }));

import { resolveBreakglassOperator } from "@/lib/breakglass/auth";

const SECRET = "breakglass-credential-test-secret-0123456789";
const OPERATOR_ID = "user-operator";
const OPERATOR_EMAIL = "alice@x.io";

const ENV_KEYS = [
	"ALETHIA_BREAKGLASS_ENABLED",
	"BREAKGLASS_OPERATORS",
	"BREAKGLASS_DEV_EMAIL",
	"BREAKGLASS_ACCESS_PROXY_SECRET",
	"CLI_JWT_SECRET",
];
let saved: Record<string, string | undefined>;

/** A db stub whose `select().from().where().limit()` chain answers with the operator's email. */
function stubDb() {
	const chain = {
		select: () => chain,
		from: () => chain,
		where: () => chain,
		limit: async () => [{ email: OPERATOR_EMAIL }],
	};
	getServiceDb.mockReturnValue(chain);
}

/** A request carrying `bearer` as its Authorization header. */
function bearerReq(bearer: string): Request {
	return new Request("https://console.test/api/breakglass/whatever", {
		headers: { Authorization: `Bearer ${bearer}` },
	});
}

/** Signs an interactive CLI session JWT for the operator, as the device-login flow does. */
function sessionJwt(): Promise<string> {
	return new jose.SignJWT({ type: "access" })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(OPERATOR_ID)
		.setIssuer("urn:example:issuer")
		.setAudience("urn:example:audience")
		.setExpirationTime("5m")
		.sign(new TextEncoder().encode(SECRET));
}

beforeEach(() => {
	saved = {};
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
	process.env.ALETHIA_BREAKGLASS_ENABLED = "true";
	process.env.BREAKGLASS_OPERATORS = OPERATOR_EMAIL;
	process.env.CLI_JWT_SECRET = SECRET;
	vi.clearAllMocks();
	stubDb();
	resolveServiceToken.mockResolvedValue({
		tokenId: "tok-1",
		organizationId: "org-A",
		name: "ci",
		createdBy: OPERATOR_ID,
	});
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("break-glass bearer credential kind (#5496)", () => {
	it("refuses a service token even when its minter is an allowlisted operator", async () => {
		const op = await resolveBreakglassOperator(bearerReq("alethia_sat_minted-by-operator"));
		expect(resolveServiceToken).toHaveBeenCalledTimes(1);
		expect(op).toBeNull();
	});

	it("accepts the same operator's interactive CLI session", async () => {
		const op = await resolveBreakglassOperator(bearerReq(await sessionJwt()));
		expect(op).toEqual({ email: OPERATOR_EMAIL, userId: OPERATOR_ID });
	});
});
