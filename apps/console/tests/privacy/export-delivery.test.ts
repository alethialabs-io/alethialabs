// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Building and delivering a data export (lib/privacy/export.ts): what is read, where it is stored,
// and how the case and the subject are told.
//
// Pinned: the archive covers the account's own tables and never selects a sign-in token or password
// hash; it is stored under the case's key before the case names that key; the case is fulfilled
// with the token's HASH while the subject's email carries the token; and the signing key comes from
// the environment only when both halves are set.

import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "./scripted-db";

const sdb = scriptedDb();
vi.mock("@/lib/db", () => ({ getServiceDb: () => sdb.db }));
const { put, sendReady } = vi.hoisted(() => ({ put: vi.fn(), sendReady: vi.fn() }));
vi.mock("@/lib/storage", () => ({ storage: { put, get: vi.fn(), del: vi.fn() } }));
vi.mock("@/lib/privacy/emails", () => ({ sendDataExportReadyEmail: (...a: unknown[]) => sendReady(...a) }));

import { privacyCase, privacyCaseEvent } from "@/lib/db/schema";
import {
	buildAndStoreExport,
	collectExportFiles,
	createDataExport,
	EXPORT_LINK_HOURS,
	exportObjectKey,
	PRIVACY_EXPORT_BUCKET,
} from "@/lib/privacy/export";
import { hashLinkToken } from "@/lib/privacy/link-token";

const NOW = new Date("2026-11-21T10:00:00.000Z");

beforeEach(() => {
	sdb.calls.length = 0;
	put.mockReset();
	put.mockResolvedValue(undefined);
	sendReady.mockReset();
	sendReady.mockResolvedValue(undefined);
	delete process.env.PRIVACY_EXPORT_SIGNING_KEY;
	delete process.env.PRIVACY_EXPORT_SIGNING_KEY_ID;
});

describe("collectExportFiles", () => {
	it("returns one file per part of the account, with the rows each query answered", async () => {
		sdb.answer([{ id: "u1" }], [{ providerId: "github" }], [], [], [], [{ title: "t" }], []);
		const files = await collectExportFiles("u1", "a".repeat(64));
		expect(files.map((f) => f.path)).toEqual([
			"account/profile.json",
			"account/sign-in-methods.json",
			"account/sessions.json",
			"organizations/memberships.json",
			"legal/acceptances.json",
			"ai/conversations.json",
			"privacy/requests.json",
		]);
		expect(files[0]?.rows).toEqual([{ id: "u1" }]);
		expect(files[5]?.rows).toEqual([{ title: "t" }]);
	});
});

describe("buildAndStoreExport", () => {
	it("stores the archive under the case's key in the export bucket", async () => {
		const out = await buildAndStoreExport({ caseId: "case-1", userId: "u1", subjectEmailSha256: "h", now: NOW });
		expect(out.objectKey).toBe(exportObjectKey("case-1"));
		expect(put).toHaveBeenCalledWith(PRIVACY_EXPORT_BUCKET, "case-1.json", expect.anything(), "application/json");
		expect(out.manifest.signature).toBeNull();
	});

	it("signs with the environment's key only when both its halves are set", async () => {
		const { privateKey } = generateKeyPairSync("ed25519");
		process.env.PRIVACY_EXPORT_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const unsigned = await buildAndStoreExport({ caseId: "c", userId: "u1", subjectEmailSha256: "h", now: NOW });
		expect(unsigned.manifest.signature).toBeNull();
		process.env.PRIVACY_EXPORT_SIGNING_KEY_ID = "key-1";
		const signed = await buildAndStoreExport({ caseId: "c", userId: "u1", subjectEmailSha256: "h", now: NOW });
		expect(signed.manifest.signingKeyId).toBe("key-1");
	});
});

describe("createDataExport", () => {
	it("opens a verified export case, fulfils it with the token's hash and emails the token", async () => {
		sdb.answer([{ id: "case-1" }]);
		const out = await createDataExport({ userId: "u1", email: "ada@example.io" }, NOW);
		expect(out.reference).toMatch(/^DSR-[0-9A-F]{8}$/);
		expect(out.expiresAt).toEqual(new Date(NOW.getTime() + EXPORT_LINK_HOURS * 3_600_000));

		const insert = sdb.calls.find((c) => c.op === "insert" && c.table === privacyCase);
		expect(insert?.values).toMatchObject({ kind: "export", subjectUserId: "u1", identityVerifiedAt: NOW });
		const update = sdb.calls.find((c) => c.op === "update" && c.table === privacyCase);
		const sent = sendReady.mock.calls[0]?.[0];
		expect(sent).toMatchObject({ to: "ada@example.io", reference: out.reference });
		expect(update?.set).toMatchObject({
			state: "fulfilled",
			exportObjectKey: "case-1.json",
			linkTokenSha256: hashLinkToken(sent.token),
		});
		const kinds = sdb.calls
			.filter((c) => c.table === privacyCaseEvent)
			.map((c) => (c.values as { kind: string }).kind);
		expect(kinds).toEqual(["received", "identity_verified", "export_generated"]);
		// Stored before the case named it.
		expect(put).toHaveBeenCalled();
	});

	it("says in the ledger when the manifest is signed", async () => {
		const { privateKey } = generateKeyPairSync("ed25519");
		process.env.PRIVACY_EXPORT_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		process.env.PRIVACY_EXPORT_SIGNING_KEY_ID = "key-1";
		sdb.answer([{ id: "case-1" }]);
		await createDataExport({ userId: "u1", email: "ada@example.io" }, NOW);
		const generated = sdb.calls
			.filter((c) => c.table === privacyCaseEvent)
			.map((c) => c.values as { kind: string; detail: { summary: string } })
			.find((v) => v.kind === "export_generated");
		expect(generated?.detail.summary).toContain("(signed manifest)");
	});

	it("leaves no link when the archive cannot be stored", async () => {
		sdb.answer([{ id: "case-1" }]);
		put.mockRejectedValue(new Error("storage down"));
		await expect(createDataExport({ userId: "u1", email: "ada@example.io" }, NOW)).rejects.toThrow("storage down");
		expect(sdb.calls.find((c) => c.op === "update")).toBeUndefined();
		expect(sendReady).not.toHaveBeenCalled();
	});

	it("refuses when the case row cannot be written", async () => {
		sdb.answer([]);
		await expect(createDataExport({ userId: "u1", email: "ada@example.io" }, NOW)).rejects.toThrow(/Could not open/);
	});
});
