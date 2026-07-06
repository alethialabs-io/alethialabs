// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the pre-auth email gate (requestEmailCode): stub a
// thenable drizzle chain for the account lookup, the auth config (baseURL), and
// the no-account email sender, then assert each branch — login/no-account emails
// + returns "no-account", login/has-account and signup return "send-otp", input
// is normalized, signup never hits the DB, and a failing email is swallowed.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/email/auth-email", () => ({ sendNoAccountEmail: vi.fn() }));
vi.mock("@/lib/config/auth", () => ({ getAuthConfig: vi.fn() }));

import { requestEmailCode } from "@/app/server/actions/auth";
import { getAuthConfig } from "@/lib/config/auth";
import { getServiceDb } from "@/lib/db";
import { sendNoAccountEmail } from "@/lib/email/auth-email";

/**
 * A drizzle-ish select chain that records the `where` predicate and resolves the
 * terminal `.limit()` to the seeded account-lookup rows.
 */
function mockDb(rows: unknown[]) {
	const whereSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: (...a: unknown[]) => {
			whereSpy(...a);
			return db;
		},
		limit: () => Promise.resolve(rows),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { whereSpy };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getAuthConfig).mockReturnValue({ baseURL: "https://app.test" } as never);
	vi.mocked(sendNoAccountEmail).mockResolvedValue(undefined as never);
});

describe("requestEmailCode", () => {
	it("login with no account: sends the no-account email and returns no-account", async () => {
		mockDb([]); // lookup finds no user

		const result = await requestEmailCode({ email: "nobody@test.dev", mode: "login" });

		expect(result).toEqual({ outcome: "no-account" });
		expect(sendNoAccountEmail).toHaveBeenCalledTimes(1);
		expect(sendNoAccountEmail).toHaveBeenCalledWith(
			"nobody@test.dev",
			"https://app.test/signup",
		);
	});

	it("login with an existing account: returns send-otp and does not email", async () => {
		mockDb([{ id: "user-1" }]); // lookup finds a user

		const result = await requestEmailCode({ email: "someone@test.dev", mode: "login" });

		expect(result).toEqual({ outcome: "send-otp" });
		expect(sendNoAccountEmail).not.toHaveBeenCalled();
	});

	it("signup always returns send-otp without checking the DB or emailing", async () => {
		mockDb([]); // would be empty, but signup must not consult it

		const result = await requestEmailCode({ email: "newuser@test.dev", mode: "signup" });

		expect(result).toEqual({ outcome: "send-otp" });
		// signup short-circuits before the account lookup / no-account email
		expect(getServiceDb).not.toHaveBeenCalled();
		expect(sendNoAccountEmail).not.toHaveBeenCalled();
	});

	it("normalizes the email (trim + lowercase) for both the lookup and the email", async () => {
		const { whereSpy } = mockDb([]); // no account → exercises the email path

		const result = await requestEmailCode({ email: "  MixedCase@Test.DEV  ", mode: "login" });

		expect(result).toEqual({ outcome: "no-account" });
		// the lookup ran (predicate captured) and the email used the normalized address
		expect(whereSpy).toHaveBeenCalledTimes(1);
		expect(sendNoAccountEmail).toHaveBeenCalledWith(
			"mixedcase@test.dev",
			"https://app.test/signup",
		);
	});

	it("uses the configured baseURL for the signup link", async () => {
		vi.mocked(getAuthConfig).mockReturnValue({ baseURL: "https://other.example" } as never);
		mockDb([]);

		await requestEmailCode({ email: "x@test.dev", mode: "login" });

		expect(sendNoAccountEmail).toHaveBeenCalledWith(
			"x@test.dev",
			"https://other.example/signup",
		);
	});

	it("swallows a failing no-account email and still returns no-account", async () => {
		mockDb([]);
		vi.mocked(sendNoAccountEmail).mockRejectedValue(new Error("SES down") as never);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await requestEmailCode({ email: "boom@test.dev", mode: "login" });

		expect(result).toEqual({ outcome: "no-account" });
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});
});
