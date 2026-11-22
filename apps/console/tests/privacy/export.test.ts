// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "Download my data" (lib/privacy/export.ts).
//
// The FORMAT is asserted exactly, because a recipient checks it without us: the manifest's digest is
// the digest of the archive string in the envelope, every part's digest is the digest of that
// file's contents, and a configured key signs it so `verifyManifest` accepts it. The DOWNLOAD is
// asserted for the three things that must all hold — the subject's own account, the emailed token,
// an unexpired link — and for answering a wrong account and a wrong token identically.

import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "./scripted-db";

const sdb = scriptedDb();
vi.mock("@/lib/db", () => ({ getServiceDb: () => sdb.db }));
const { storageGet, storageDel, storagePut } = vi.hoisted(() => ({
	storageGet: vi.fn(),
	storageDel: vi.fn(),
	storagePut: vi.fn(),
}));
vi.mock("@/lib/storage", () => ({
	storage: { get: storageGet, del: storageDel, put: storagePut },
}));
vi.mock("@/lib/privacy/emails", () => ({ sendDataExportReadyEmail: vi.fn(async () => undefined) }));

import { privacyCase, privacyCaseEvent } from "@/lib/db/schema";
import {
	assembleExport,
	PRIVACY_EXPORT_BUCKET,
	readExportForDownload,
	sweepExpiredExports,
} from "@/lib/privacy/export";
import { hashLinkToken } from "@/lib/privacy/link-token";
import { archiveMatchesManifest, sha256Hex, verifyManifest } from "@/lib/privacy/manifest";

const NOW = new Date("2026-11-21T10:00:00.000Z");
const FILES = [
	{ path: "account/profile.json", describes: "Your account.", rows: [{ id: "u1", email: "ada@example.io" }] },
	{ path: "ai/conversations.json", describes: "Your conversations.", rows: [] },
];

/** Parses the downloadable envelope. */
function envelope(bytes: Uint8Array): { manifest: Parameters<typeof verifyManifest>[0]; archive: string } {
	return JSON.parse(new TextDecoder().decode(bytes));
}

describe("assembleExport", () => {
	it("describes the archive string exactly: its digest, its length and every part's digest", () => {
		const built = assembleExport(FILES, NOW, null);
		const { manifest, archive } = envelope(built.bytes);
		const archiveBytes = new TextEncoder().encode(archive);

		expect(archiveMatchesManifest(manifest, archiveBytes)).toEqual({ ok: true });
		const parsed = JSON.parse(archive);
		expect(parsed.format).toBe("alethia-data-export/1");
		expect(manifest.parts.map((p) => [p.path, p.rows])).toEqual([
			["account/profile.json", 1],
			["ai/conversations.json", 0],
		]);
		for (const part of manifest.parts) {
			expect(part.sha256).toBe(sha256Hex(parsed.files[part.path]));
		}
	});

	it("does not verify a signed manifest against a key that is not a key", () => {
		const { privateKey } = generateKeyPairSync("ed25519");
		const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const { manifest } = envelope(assembleExport(FILES, NOW, { pem, id: "key-2026" }).bytes);
		expect(verifyManifest(manifest, "not a pem")).toBe(false);
	});

	it("says honestly that it is unsigned when the deployment has no key", () => {
		const { manifest } = envelope(assembleExport(FILES, NOW, null).bytes);
		expect(manifest.signature).toBeNull();
		expect(manifest.signingKeyId).toBeNull();
	});

	it("signs with the configured ed25519 key, so the recipient's check passes", () => {
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const { manifest } = envelope(assembleExport(FILES, NOW, { pem, id: "key-2026" }).bytes);
		expect(manifest.signingKeyId).toBe("key-2026");
		expect(verifyManifest(manifest, publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(true);
	});
});

describe("readExportForDownload", () => {
	const TOKEN = "a".repeat(43);
	const row = {
		id: "case-1",
		reference: "DSR-00000001",
		subjectUserId: "user-1",
		linkTokenSha256: hashLinkToken(TOKEN),
		exportObjectKey: "case-1.json",
		exportExpiresAt: new Date(NOW.getTime() + 3_600_000),
	};

	beforeEach(() => {
		sdb.calls.length = 0;
		storageGet.mockReset();
	});

	it("streams the export to its subject holding the token, and records the download", async () => {
		sdb.answer([row]);
		storageGet.mockResolvedValue(new Uint8Array([1, 2, 3]));
		const out = await readExportForDownload({ reference: row.reference, token: TOKEN, userId: "user-1", now: NOW });
		expect(out).toEqual({ outcome: "ok", bytes: new Uint8Array([1, 2, 3]), reference: row.reference });
		expect(storageGet).toHaveBeenCalledWith(PRIVACY_EXPORT_BUCKET, "case-1.json");
		const event = sdb.calls.find((c) => c.table === privacyCaseEvent);
		expect(event?.values).toMatchObject({ kind: "export_downloaded", actorUserId: "user-1" });
	});

	it("answers a different account and a wrong token alike, and reads no object", async () => {
		sdb.answer([row]);
		expect(
			await readExportForDownload({ reference: row.reference, token: TOKEN, userId: "user-2", now: NOW }),
		).toEqual({ outcome: "not_found" });
		sdb.answer([row]);
		expect(
			await readExportForDownload({ reference: row.reference, token: "b".repeat(43), userId: "user-1", now: NOW }),
		).toEqual({ outcome: "not_found" });
		expect(storageGet).not.toHaveBeenCalled();
	});

	it("answers expired when the archive is already gone from storage", async () => {
		sdb.answer([row]);
		storageGet.mockResolvedValue(null);
		expect(
			await readExportForDownload({ reference: row.reference, token: TOKEN, userId: "user-1", now: NOW }),
		).toEqual({ outcome: "expired" });
	});

	it("refuses an expired link even before the sweep has deleted the archive", async () => {
		sdb.answer([{ ...row, exportExpiresAt: new Date(NOW.getTime() - 1) }]);
		expect(
			await readExportForDownload({ reference: row.reference, token: TOKEN, userId: "user-1", now: NOW }),
		).toEqual({ outcome: "expired" });
		expect(storageGet).not.toHaveBeenCalled();
	});
});

describe("sweepExpiredExports", () => {
	it("deletes each expired archive and clears its key and token, keeping the manifest", async () => {
		sdb.calls.length = 0;
		storageDel.mockReset();
		sdb.answer([{ id: "case-1", objectKey: "case-1.json" }, { id: "case-2", objectKey: null }]);
		expect(await sweepExpiredExports(NOW)).toEqual({ deleted: 1 });
		expect(storageDel).toHaveBeenCalledWith(PRIVACY_EXPORT_BUCKET, "case-1.json");
		const update = sdb.calls.find((c) => c.op === "update" && c.table === privacyCase);
		expect(update?.set).toMatchObject({ exportObjectKey: null, linkTokenSha256: null });
		expect(update?.set).not.toHaveProperty("exportManifest");
	});
});
