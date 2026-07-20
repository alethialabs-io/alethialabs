// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the org signing-key actions (#884): the register path is SHAPE-ONLY —
// it stores a reference + the server-derived key_id + the public key, lands `pending_verification`,
// and is org-gated. It must never store private material and never activate a key itself.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));

import {
	getOrgSigningKeys,
	registerOrgSigningKey,
	revokeOrgSigningKey,
} from "@/app/server/actions/signing";
import { authorize } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { orgSigningKey } from "@/lib/db/schema";

const ZERO_PUB = Buffer.alloc(32).toString("base64");
const KEY_ID = "66687aadf862bd77"; // hex(sha256(zero32)[:8]) — matches Go verify.KeyID.

type Rows = unknown[];

/** Table-aware thenable drizzle-ish tx wired through withActorScope. Records insert/update payloads. */
function setupDb(cfg: { select?: Map<unknown, Rows> }) {
	const valuesSpy = vi.fn<(t: unknown, p: unknown) => void>();
	const setSpy = vi.fn<(t: unknown, p: unknown) => void>();
	function chain(op: "select" | "insert" | "update", table?: unknown) {
		let from = table;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => ((from = t), c),
			where: () => c,
			limit: () => c,
			orderBy: () => c,
			returning: () => c,
			values: (p: unknown) => (valuesSpy(from, p), c),
			set: (p: unknown) => (setSpy(from, p), c),
			then: (res: (v: Rows) => void) =>
				res(op === "insert" ? [{ id: "key-1" }] : (cfg.select?.get(from) ?? [])),
		});
		return c;
	}
	const tx = {
		select: () => chain("select"),
		insert: (t: unknown) => chain("insert", t),
		update: (t: unknown) => chain("update", t),
	};
	vi.mocked(withActorScope).mockImplementation(
		((_a: unknown, cb: (tx: unknown) => unknown) => cb(tx)) as never,
	);
	return { valuesSpy, setSpy };
}

function valuesFor(spy: ReturnType<typeof vi.fn>, table: unknown): Record<string, unknown> {
	const call = spy.mock.calls.find((c) => c[0] === table);
	if (!call) throw new Error("no values() recorded");
	return call[1] as Record<string, unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorize).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
});

const base = { provider: "aws", backend: "kms", key_ref: "arn:aws:kms:us-east-1:1:key/abc", public_key: ZERO_PUB } as const;

describe("registerOrgSigningKey", () => {
	it("org-gates, derives key_id server-side, stores reference + public key only, lands pending_verification", async () => {
		const { valuesSpy } = setupDb({ select: new Map([[orgSigningKey, []]]) });

		const r = await registerOrgSigningKey(base);
		expect(r).toMatchObject({ ok: true, id: "key-1", keyId: KEY_ID, status: "pending_verification" });
		expect(authorize).toHaveBeenCalledWith("edit", { type: "org" });

		const vals = valuesFor(valuesSpy, orgSigningKey);
		expect(vals).toMatchObject({
			user_id: "user-1",
			org_id: "org-1",
			provider: "aws",
			backend: "kms",
			key_ref: base.key_ref,
			public_key: ZERO_PUB,
			key_id: KEY_ID, // server-derived, not client-supplied
			status: "pending_verification",
			active: false, // NEVER active on registration — that needs the proof-of-possession job
		});
		// custody model A: no private key field is ever written.
		expect(Object.keys(vals)).not.toContain("private_key");
	});

	it("rejects a duplicate public key (its key_id is UNIQUE)", async () => {
		setupDb({ select: new Map([[orgSigningKey, [{ id: "existing" }]]]) });
		await expect(registerOrgSigningKey(base)).rejects.toThrow(/already registered/);
	});

	it("rejects a malformed public key before any db work", async () => {
		setupDb({});
		await expect(registerOrgSigningKey({ ...base, public_key: "nope" })).rejects.toThrow();
	});
});

describe("getOrgSigningKeys", () => {
	it("org-gates on view and returns the mapped rows", async () => {
		setupDb({
			select: new Map([
				[
					orgSigningKey,
					[
						{
							id: "key-1",
							provider: "aws",
							backend: "kms",
							key_ref: "arn",
							public_key: ZERO_PUB,
							key_id: KEY_ID,
							algorithm: "ed25519",
							status: "pending_verification",
							active: false,
							status_message: null,
							verified_at: null,
							created_at: new Date(),
						},
					],
				],
			]),
		});
		const r = await getOrgSigningKeys();
		expect(authorize).toHaveBeenCalledWith("view", { type: "org" });
		expect(r).toHaveLength(1);
		expect(r[0]).toMatchObject({ keyId: KEY_ID, status: "pending_verification", active: false });
	});
});

describe("revokeOrgSigningKey", () => {
	it("org-gates and soft-revokes (active=false, status=invalid) — keeps the history row", async () => {
		const { setSpy } = setupDb({});
		await expect(revokeOrgSigningKey("key-1")).resolves.toEqual({ ok: true });
		expect(authorize).toHaveBeenCalledWith("edit", { type: "org" });
		expect(valuesFor(setSpy, orgSigningKey)).toMatchObject({ active: false, status: "invalid" });
	});
});
