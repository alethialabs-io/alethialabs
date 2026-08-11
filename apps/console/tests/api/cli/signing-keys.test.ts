// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET /api/cli/signing-keys is the trusted-key set `alethia verify receipt` binds a receipt's
// key_id against (#2331). Two things are worth proving here and nothing else is: that custody
// material never reaches the wire, and that the platform key is present — because today's
// receipts are platform-signed, so a response carrying only org keys would fail closed on every
// receipt in existence.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));
vi.mock("@/lib/queries/signing", () => ({ getOrgSigningKeys: vi.fn() }));
vi.mock("@/lib/evidence/platform-key", () => ({ platformSigningKey: vi.fn() }));

import { GET } from "@/app/api/cli/signing-keys/route";
import { authorizeCli } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { platformSigningKey } from "@/lib/evidence/platform-key";
import { getOrgSigningKeys } from "@/lib/queries/signing";

const ORG_KEY = {
	id: "row-1",
	provider: "aws",
	backend: "kms" as const,
	keyRef: "arn:aws:kms:us-east-1:123456789012:key/SECRET-CUSTODY-REF",
	keyId: "0123456789abcdef",
	publicKey: "cHVibGljLWtleS1ieXRlcy0zMi1sb25nLWFhYWFhYWE=",
	algorithm: "ed25519",
	status: "active" as const,
	active: true,
	statusMessage: null,
	verifiedAt: null,
	createdAt: "2026-08-01T00:00:00.000Z",
};

const PLATFORM = {
	keyId: "fedcba9876543210",
	publicKey: "cGxhdGZvcm0ta2V5LWJ5dGVzLTMyLWxvbmctYWFhYQ==",
	algorithm: "ed25519",
};

function req(): Request {
	return new Request("https://console.local/api/cli/signing-keys");
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: "user-1", orgId: "org-1" },
	} as never);
	// withActorScope hands the callback a tx; the query itself is mocked, so a stub suffices.
	vi.mocked(withActorScope).mockImplementation((async (
		_actor: unknown,
		fn: (tx: unknown) => unknown,
	) => fn({})) as never);
	vi.mocked(getOrgSigningKeys).mockResolvedValue([ORG_KEY] as never);
	vi.mocked(platformSigningKey).mockReturnValue(PLATFORM as never);
});

describe("GET /api/cli/signing-keys", () => {
	it("serves the org's keys and the platform key in one list", async () => {
		const res = await GET(req());
		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.signing_keys).toHaveLength(2);
		const org = body.signing_keys.find(
			(k: { source: string }) => k.source === "org",
		);
		const platform = body.signing_keys.find(
			(k: { source: string }) => k.source === "platform",
		);

		expect(org).toMatchObject({
			key_id: ORG_KEY.keyId,
			public_key: ORG_KEY.publicKey,
			algorithm: "ed25519",
			provider: "aws",
			status: "active",
			active: true,
		});
		// The platform entry has no org row behind it, so provider/status are null rather than
		// invented.
		expect(platform).toMatchObject({
			key_id: PLATFORM.keyId,
			public_key: PLATFORM.publicKey,
			source: "platform",
			provider: null,
			status: null,
			active: true,
		});
	});

	// key_ref names a resource in the CUSTOMER's cloud and backend describes their custody. A
	// verifier needs neither, so neither goes on the wire.
	it("never puts custody material on the wire", async () => {
		const res = await GET(req());
		const raw = JSON.stringify(await res.json());

		expect(raw).not.toContain("SECRET-CUSTODY-REF");
		expect(raw).not.toContain("key_ref");
		expect(raw).not.toContain("keyRef");
		expect(raw).not.toContain("backend");
	});

	// A deployment that signs nothing has no platform key to vouch for. Serving the org keys
	// alone is the honest answer; inventing an entry would be worse.
	it("omits the platform entry when no signing key is configured", async () => {
		vi.mocked(platformSigningKey).mockReturnValue(null);
		const res = await GET(req());
		const body = await res.json();

		expect(body.signing_keys).toHaveLength(1);
		expect(body.signing_keys[0].source).toBe("org");
	});

	it("serves an empty list for an org with no keys and no platform key", async () => {
		vi.mocked(getOrgSigningKeys).mockResolvedValue([] as never);
		vi.mocked(platformSigningKey).mockReturnValue(null);
		const res = await GET(req());

		expect(res.status).toBe(200);
		expect((await res.json()).signing_keys).toEqual([]);
	});

	it("passes the authz refusal through untouched", async () => {
		vi.mocked(authorizeCli).mockResolvedValue({
			error: new Response("forbidden", { status: 403 }),
		} as never);
		const res = await GET(req());
		expect(res.status).toBe(403);
		expect(getOrgSigningKeys).not.toHaveBeenCalled();
	});

	it("reports a query failure as a 500 rather than throwing", async () => {
		vi.mocked(withActorScope).mockRejectedValue(new Error("db down") as never);
		const res = await GET(req());
		expect(res.status).toBe(500);
		expect((await res.json()).error).toBe("db down");
	});
});
