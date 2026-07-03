// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cli/auth", () => ({
	verifyCliToken: vi.fn(),
}));

// Cloud connections are org-scoped: resolveCliProvider resolves the actor's scope.
// Stub it so the pure provider-resolution logic stays DB-free in this unit test.
vi.mock("@/lib/auth/scope", () => ({
	getActiveScope: vi.fn(async (userId: string) => ({
		userId,
		orgId: userId,
		entitlements: {},
	})),
}));

import { verifyCliToken } from "@/lib/cli/auth";
import {
	errorResponse,
	isCloudProvider,
	resolveCliProvider,
} from "@/lib/cli/providers";

const mockedVerify = vi.mocked(verifyCliToken);

function req() {
	return new Request("http://localhost/api/cli/providers/aws/init");
}

describe("isCloudProvider", () => {
	it("accepts the supported providers", () => {
		expect(isCloudProvider("aws")).toBe(true);
		expect(isCloudProvider("gcp")).toBe(true);
		expect(isCloudProvider("azure")).toBe(true);
	});

	it("rejects anything else", () => {
		expect(isCloudProvider("kubernetes")).toBe(false);
		expect(isCloudProvider("AWS")).toBe(false);
		expect(isCloudProvider("")).toBe(false);
	});
});

describe("errorResponse", () => {
	it("maps an Error to a 400 JSON response", async () => {
		const resp = errorResponse(new Error("boom"));
		expect(resp.status).toBe(400);
		expect(await resp.json()).toEqual({ error: "boom" });
	});

	it("respects a custom status", () => {
		expect(errorResponse(new Error("nope"), 500).status).toBe(500);
	});

	it("falls back to a generic message for non-Error values", async () => {
		const resp = errorResponse("weird", 500);
		expect(await resp.json()).toEqual({ error: "Internal Server Error" });
	});
});

describe("resolveCliProvider", () => {
	it("propagates the auth error response when the token is invalid", async () => {
		mockedVerify.mockResolvedValue({
			payload: null,
			error: new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
			}),
		});

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "aws" }),
		);
		expect(result.userId).toBeNull();
		expect(result.provider).toBeNull();
		expect(result.errorResponse?.status).toBe(401);
	});

	it("returns 400 for an unsupported provider", async () => {
		mockedVerify.mockResolvedValue({
			payload: { sub: "user-123" },
			error: null,
		});

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "kubernetes" }),
		);
		expect(result.userId).toBeNull();
		expect(result.errorResponse?.status).toBe(400);
	});

	it("resolves the user id and typed provider for a valid request", async () => {
		mockedVerify.mockResolvedValue({
			payload: { sub: "user-123" },
			error: null,
		});

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "gcp" }),
		);
		expect(result.errorResponse).toBeNull();
		expect(result.userId).toBe("user-123");
		expect(result.provider).toBe("gcp");
		expect(result.scope).toEqual({
			userId: "user-123",
			orgId: "user-123",
			entitlements: {},
		});
	});

	it("returns 401 when the payload has no subject", async () => {
		mockedVerify.mockResolvedValue({
			payload: {},
			error: null,
		});

		const result = await resolveCliProvider(
			req(),
			Promise.resolve({ provider: "aws" }),
		);
		expect(result.errorResponse?.status).toBe(401);
	});
});
