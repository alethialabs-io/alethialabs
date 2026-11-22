// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The token-carrying routes a privacy email links to:
//   · POST /api/account/deletion/cancel — the "Keep my account" button;
//   · GET  /api/privacy/export/<reference> — the export download.
//
// Pinned: a bad token changes nothing; a cancel never happens on a GET (there is none);
// and a download needs a session, sends a signed-out person to sign in and back, and answers a
// missing export with the same 404 a wrong account gets.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { cancel, getSession, readExport } = vi.hoisted(() => ({
	cancel: vi.fn(),
	getSession: vi.fn(),
	readExport: vi.fn(),
}));
vi.mock("@/lib/privacy/self-deletion", () => ({ cancelScheduledErasure: (...a: unknown[]) => cancel(...a) }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: (...a: unknown[]) => getSession(...a) } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/privacy/export", () => ({ readExportForDownload: (...a: unknown[]) => readExport(...a) }));

import { POST as cancelPost } from "@/app/api/account/deletion/cancel/route";
import { GET as download } from "@/app/api/privacy/export/[reference]/route";

const ORIGIN = "https://console.example.io";
const TOKEN = "t".repeat(43);

beforeEach(() => {
	for (const m of [cancel, getSession, readExport]) m.mockReset();
});

describe("POST /api/account/deletion/cancel", () => {
	/** A form POST carrying `t`. */
	function form(t: string): Request {
		return new Request(`${ORIGIN}/api/account/deletion/cancel`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: `t=${encodeURIComponent(t)}`,
		});
	}

	it("cancels by the posted token and shows the result", async () => {
		cancel.mockResolvedValue({ outcome: "cancelled", reference: "DSR-00000001" });
		const res = await cancelPost(form(TOKEN));
		expect(cancel).toHaveBeenCalledWith({ token: TOKEN }, "link", expect.any(Date));
		expect(res.headers.get("location")).toBe(`${ORIGIN}/account/deletion?result=cancelled`);
	});

	it("does not look up a token that is not shaped like one", async () => {
		const res = await cancelPost(form("short"));
		expect(cancel).not.toHaveBeenCalled();
		expect(res.headers.get("location")).toBe(`${ORIGIN}/account/deletion?result=invalid`);
	});
});

describe("GET /api/privacy/export/[reference]", () => {
	const params = { params: Promise.resolve({ reference: "DSR-0000000B" }) };

	it("sends a signed-out person to sign in and back to the same link", async () => {
		getSession.mockResolvedValue(null);
		const res = await download(new Request(`${ORIGIN}/api/privacy/export/DSR-0000000B?t=${TOKEN}`), params);
		expect(res.status).toBe(307);
		const next = new URL(res.headers.get("location") ?? "").searchParams.get("next");
		expect(next).toBe(`/api/privacy/export/DSR-0000000B?t=${TOKEN}`);
		expect(readExport).not.toHaveBeenCalled();
	});

	it("streams the export as an attachment to its subject", async () => {
		getSession.mockResolvedValue({ user: { id: "user-1" } });
		readExport.mockResolvedValue({ outcome: "ok", bytes: new TextEncoder().encode("{}"), reference: "DSR-0000000B" });
		const res = await download(new Request(`${ORIGIN}/api/privacy/export/DSR-0000000B?t=${TOKEN}`), params);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-disposition")).toContain("alethia-data-DSR-0000000B.json");
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(readExport).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", token: TOKEN }));
	});

	it("answers 404 for someone else's export and 410 for an expired one", async () => {
		getSession.mockResolvedValue({ user: { id: "user-2" } });
		readExport.mockResolvedValue({ outcome: "not_found" });
		expect((await download(new Request(`${ORIGIN}/api/privacy/export/DSR-0000000B?t=${TOKEN}`), params)).status).toBe(404);
		readExport.mockResolvedValue({ outcome: "expired" });
		expect((await download(new Request(`${ORIGIN}/api/privacy/export/DSR-0000000B?t=${TOKEN}`), params)).status).toBe(410);
	});

	it("refuses a token that is not shaped like one before reading the session", async () => {
		const res = await download(new Request(`${ORIGIN}/api/privacy/export/DSR-0000000B?t=x`), params);
		expect(res.status).toBe(404);
		expect(getSession).not.toHaveBeenCalled();
	});
});
