// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The connectors board's cloud-account writes (#6124, ADR 0005 D4): `connectCloudAccount`,
// `verifyCloudAccount`, `renameCloudAccount`, `disconnectCloudAccount`, `startCloudConnect`.
//
// Mocked boundaries: the PDP guard, the service DB (the identity lookup), and the connection
// library. What is pinned is the ORDER of the gates and the typed result of each refusal:
//   1. a malformed value is a `validation` refusal with the field named — nothing else runs;
//   2. a PDP deny is `forbidden` — no lookup, no write;
//   3. an id the scope rule + the addressed org do not admit is `not-found` — the PDP's answer does
//      not matter, and the connection library is never called;
//   4. a connect session of another cloud is `conflict`;
//   5. only then does the library run, and its result travels without any credential in it.
// The tenancy of the lookup against real rows is tests/integration/cloud-account-actions.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as unknown[], where: [] as unknown[] }));

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn() }));
vi.mock("@/lib/auth/accounts", () => ({ resolveAccountId: vi.fn() }));
vi.mock("@/lib/connectors/health", () => ({ markHealthy: vi.fn(), markFailed: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	authorizeQuiet: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({
			from: () => ({
				where: (w: unknown) => {
					h.where.push(w);
					return { limit: async () => h.rows };
				},
			}),
		}),
	}),
}));
vi.mock("@/lib/cloud-providers/connections", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cloud-providers/connections")>();
	return {
		// The pure parsers are the real ones: the input schema validates with them.
		parseAwsRoleArn: actual.parseAwsRoleArn,
		parseWifConfig: actual.parseWifConfig,
		initIdentity: vi.fn(),
		saveAwsIdentity: vi.fn(),
		saveGcpIdentity: vi.fn(),
		saveGcpIdentityFromIds: vi.fn(),
		saveAzureIdentity: vi.fn(),
		saveAlibabaIdentity: vi.fn(),
		saveTokenCloudIdentity: vi.fn(),
		reverifyConnection: vi.fn(),
		renameIdentity: vi.fn(),
		disconnectIdentity: vi.fn(),
	};
});

import {
	connectCloudAccount,
	disconnectCloudAccount,
	renameCloudAccount,
	startCloudConnect,
	verifyCloudAccount,
} from "@/app/server/actions/identities";
import { authorize, authorizeQuiet } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import * as conn from "@/lib/cloud-providers/connections";

const ID = "11111111-1111-4111-8111-111111111111";
const actor = { userId: "user-1", orgId: "org-1", credential: "session" };
const verified: conn.ConnectionResult = {
	identityId: ID,
	verified: true,
	status: "connected",
	error: null,
	missingPermissions: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	h.rows = [{ id: ID, provider: "aws" }];
	h.where = [];
	vi.mocked(authorize).mockResolvedValue(actor as never);
	vi.mocked(authorizeQuiet).mockResolvedValue(actor as never);
});

describe("connectCloudAccount", () => {
	it("a malformed role ARN is a validation refusal on that field — no PDP, no lookup, no write", async () => {
		const r = await connectCloudAccount({ method: "aws", identityId: ID, roleArn: "arn:aws:s3:::bucket" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error.kind).toBe("validation");
		expect(!r.ok && r.error.kind === "validation" && Object.keys(r.error.fields)).toEqual(["roleArn"]);
		expect(authorize).not.toHaveBeenCalled();
		expect(conn.saveAwsIdentity).not.toHaveBeenCalled();
	});

	it("an Azure Client ID that repeats the Subscription ID is refused on the Client ID", async () => {
		const guid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const r = await connectCloudAccount({
			method: "azure",
			identityId: ID,
			tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			clientId: guid,
			subscriptionId: guid,
		});
		expect(!r.ok && r.error.kind === "validation" && Object.keys(r.error.fields)).toEqual(["clientId"]);
		expect(conn.saveAzureIdentity).not.toHaveBeenCalled();
	});

	it("a PDP deny is forbidden, and nothing is looked up or written", async () => {
		vi.mocked(authorize).mockRejectedValue(new ForbiddenError("manage_identities", { type: "cloud_identity", id: ID }));
		const r = await connectCloudAccount({ method: "aws", identityId: ID, roleArn: "arn:aws:iam::123456789012:role/r" });
		expect(!r.ok && r.error.kind).toBe("forbidden");
		expect(h.where).toHaveLength(0);
		expect(conn.saveAwsIdentity).not.toHaveBeenCalled();
	});

	it("an id the scope rule does not admit in the addressed org is not-found, whatever the PDP said", async () => {
		h.rows = [];
		const r = await connectCloudAccount({ method: "aws", identityId: ID, roleArn: "arn:aws:iam::123456789012:role/r" });
		expect(r).toEqual({ ok: false, error: { kind: "not-found", message: expect.any(String) } });
		expect(conn.saveAwsIdentity).not.toHaveBeenCalled();
	});

	it("a connect session of another cloud is a conflict", async () => {
		h.rows = [{ id: ID, provider: "gcp" }];
		const r = await connectCloudAccount({ method: "aws", identityId: ID, roleArn: "arn:aws:iam::123456789012:role/r" });
		expect(!r.ok && r.error.kind).toBe("conflict");
		expect(conn.saveAwsIdentity).not.toHaveBeenCalled();
	});

	it("saves through the library with the PDP's actor and returns the verify outcome", async () => {
		vi.mocked(conn.saveAwsIdentity).mockResolvedValue(verified);
		const r = await connectCloudAccount({ method: "aws", identityId: ID, roleArn: "arn:aws:iam::123456789012:role/r" });
		expect(authorize).toHaveBeenCalledWith("manage_identities", { type: "cloud_identity", id: ID });
		expect(conn.saveAwsIdentity).toHaveBeenCalledWith(actor, ID, "arn:aws:iam::123456789012:role/r");
		expect(r).toEqual({ ok: true, data: verified });
	});

	it("an account that does not authenticate is a SUCCESS with verified=false and the reason", async () => {
		h.rows = [{ id: ID, provider: "hetzner" }];
		vi.mocked(conn.saveTokenCloudIdentity).mockResolvedValue({
			...verified,
			verified: false,
			status: "disconnected",
			error: "401 unauthorized",
		});
		const r = await connectCloudAccount({
			method: "token",
			identityId: ID,
			provider: "hetzner",
			token: "x".repeat(32),
		});
		expect(r).toEqual({ ok: true, data: expect.objectContaining({ verified: false, error: "401 unauthorized" }) });
	});

	it("a half S3 key pair is refused on the missing half", async () => {
		const r = await connectCloudAccount({
			method: "token",
			identityId: ID,
			provider: "hetzner",
			token: "x".repeat(32),
			s3AccessKey: "AK",
		});
		expect(!r.ok && r.error.kind === "validation" && Object.keys(r.error.fields)).toEqual(["s3SecretKey"]);
	});
});

describe("verify / rename / disconnect", () => {
	it("each refuses an unreachable id as not-found without calling the library", async () => {
		h.rows = [];
		const results = await Promise.all([
			verifyCloudAccount({ identityId: ID }),
			renameCloudAccount({ identityId: ID, name: "prod" }),
			disconnectCloudAccount({ identityId: ID }),
		]);
		for (const r of results) expect(!r.ok && r.error.kind).toBe("not-found");
		expect(conn.reverifyConnection).not.toHaveBeenCalled();
		expect(conn.renameIdentity).not.toHaveBeenCalled();
		expect(conn.disconnectIdentity).not.toHaveBeenCalled();
	});

	it("disconnect uses the STORED provider, not anything the browser sent", async () => {
		h.rows = [{ id: ID, provider: "azure" }];
		vi.mocked(conn.disconnectIdentity).mockResolvedValue({ success: true });
		const r = await disconnectCloudAccount({ identityId: ID });
		expect(conn.disconnectIdentity).toHaveBeenCalledWith(actor, ID, "azure");
		expect(r).toEqual({ ok: true, data: { identityId: ID } });
	});

	it("a blank name is a validation refusal", async () => {
		const r = await renameCloudAccount({ identityId: ID, name: "   " });
		expect(!r.ok && r.error.kind).toBe("validation");
		expect(conn.renameIdentity).not.toHaveBeenCalled();
	});

	it("an id that is not a uuid never reaches the database", async () => {
		const r = await verifyCloudAccount({ identityId: "1 OR 1=1" });
		expect(!r.ok && r.error.kind).toBe("validation");
		expect(h.where).toHaveLength(0);
	});

	it("re-verify returns the library's outcome", async () => {
		vi.mocked(conn.reverifyConnection).mockResolvedValue(verified);
		expect(await verifyCloudAccount({ identityId: ID })).toEqual({ ok: true, data: verified });
	});
});

describe("startCloudConnect", () => {
	it("starts a pending identity for a known cloud", async () => {
		vi.mocked(conn.initIdentity).mockResolvedValue({ identityId: ID });
		expect(await startCloudConnect({ provider: "gcp" })).toEqual({ ok: true, data: { identityId: ID } });
		expect(conn.initIdentity).toHaveBeenCalledWith(actor, "gcp");
	});

	it("refuses a provider that is not a cloud", async () => {
		// @ts-expect-error — the wire carries whatever the browser sent; the schema is the boundary.
		const r = await startCloudConnect({ provider: "github" });
		expect(!r.ok && r.error.kind).toBe("validation");
		expect(conn.initIdentity).not.toHaveBeenCalled();
	});
});
