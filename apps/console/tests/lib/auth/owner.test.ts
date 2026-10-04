// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// lib/auth/owner.ts over a stubbed Better Auth session and actor store: which identity each reader
// returns, what a missing or failed session lookup turns into, and that getViewer() narrows the
// session user to the fields the console renders (#5382).

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	getInjectedActor: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: mocks.getSession } } }));
vi.mock("@/lib/authz/actor-context", () => ({ getInjectedActor: mocks.getInjectedActor }));

import { UnauthorizedError } from "@/lib/auth/errors";
import {
	findOwnerScope,
	getOwner,
	getOwnerScope,
	getViewer,
	requireOwner,
} from "@/lib/auth/owner";

const createdAt = new Date("2026-01-02T03:04:05Z");

/** A session as Better Auth returns it, with a plugin-added user field the viewer must not carry. */
function sessionWith(session: { id: string; activeOrganizationId?: unknown }) {
	return {
		user: {
			id: "user-1",
			name: "Ada",
			email: "ada@example.com",
			image: undefined,
			createdAt,
			twoFactorEnabled: true,
		},
		session,
	};
}

afterEach(() => {
	mocks.getSession.mockReset();
	mocks.getInjectedActor.mockReset();
	vi.restoreAllMocks();
});

describe("getViewer", () => {
	it("narrows the session user to the rendered fields", async () => {
		mocks.getSession.mockResolvedValue(sessionWith({ id: "s-1" }));
		expect(await getViewer()).toEqual({
			id: "user-1",
			name: "Ada",
			email: "ada@example.com",
			image: null,
			createdAt,
		});
	});

	it("is null with no session, and null when the lookup throws", async () => {
		mocks.getSession.mockResolvedValue(null);
		expect(await getViewer()).toBeNull();

		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.getSession.mockRejectedValue(new Error("session table unavailable"));
		expect(await getViewer()).toBeNull();
		expect(logged).toHaveBeenCalledTimes(1);
	});
});

describe("requireOwner and getOwner", () => {
	it("takes an injected actor's user without reading the session", async () => {
		mocks.getInjectedActor.mockReturnValue({ userId: "mcp-user", orgId: "mcp-user" });
		expect(await requireOwner()).toBe("mcp-user");
		expect(mocks.getSession).not.toHaveBeenCalled();
	});

	it("returns the session user, and throws Unauthorized without one", async () => {
		mocks.getSession.mockResolvedValue(sessionWith({ id: "s-1" }));
		expect(await requireOwner()).toBe("user-1");
		expect(await getOwner()).toBe("user-1");

		mocks.getSession.mockResolvedValue(null);
		await expect(requireOwner()).rejects.toBeInstanceOf(UnauthorizedError);
		expect(await getOwner()).toBeNull();
	});
});

describe("getOwnerScope", () => {
	it("synthesizes a scope for an injected actor: no active org in community tenancy", async () => {
		mocks.getInjectedActor.mockReturnValue({ userId: "u", orgId: "u" });
		expect(await getOwnerScope()).toEqual({ userId: "u", sessionId: "", activeOrgId: undefined });

		mocks.getInjectedActor.mockReturnValue({ userId: "u", orgId: "org-9" });
		expect(await getOwnerScope()).toEqual({ userId: "u", sessionId: "", activeOrgId: "org-9" });
		expect(mocks.getSession).not.toHaveBeenCalled();
	});

	it("reads the session id and a string activeOrganizationId only", async () => {
		mocks.getSession.mockResolvedValue(sessionWith({ id: "s-1", activeOrganizationId: "org-1" }));
		expect(await getOwnerScope()).toEqual({ userId: "user-1", sessionId: "s-1", activeOrgId: "org-1" });

		mocks.getSession.mockResolvedValue(sessionWith({ id: "s-2", activeOrganizationId: 42 }));
		expect(await getOwnerScope()).toEqual({ userId: "user-1", sessionId: "s-2", activeOrgId: undefined });

		mocks.getSession.mockResolvedValue(sessionWith({ id: "s-3" }));
		expect(await getOwnerScope()).toEqual({ userId: "user-1", sessionId: "s-3", activeOrgId: undefined });
	});

	it("throws Unauthorized with no session", async () => {
		mocks.getSession.mockResolvedValue(null);
		await expect(getOwnerScope()).rejects.toBeInstanceOf(UnauthorizedError);
	});
});

describe("findOwnerScope — no session vs a failed lookup (#5472)", () => {
	it("is null with no session, and THROWS when the lookup fails, so a guard can fail closed", async () => {
		mocks.getSession.mockResolvedValue(null);
		expect(await findOwnerScope()).toBeNull();
		mocks.getSession.mockRejectedValue(new Error("session table unreachable"));
		await expect(findOwnerScope()).rejects.toThrow(/unreachable/);
	});

	it("reads the session user, session id and active org; an injected actor needs no session", async () => {
		mocks.getSession.mockResolvedValue(sessionWith({ id: "s-1", activeOrganizationId: "org-9" }));
		expect(await findOwnerScope()).toEqual({
			userId: "user-1",
			sessionId: "s-1",
			activeOrgId: "org-9",
		});
		mocks.getInjectedActor.mockReturnValue({ userId: "u-2", orgId: "org-3" });
		expect(await findOwnerScope()).toEqual({ userId: "u-2", sessionId: "", activeOrgId: "org-3" });
	});
});
