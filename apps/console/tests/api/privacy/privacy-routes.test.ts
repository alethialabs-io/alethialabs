// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The token-carrying routes a privacy or alert email links to:
//   · POST /api/email/unsubscribe — RFC 8058 one-click, and the confirmation page's button;
//   · POST /api/account/deletion/cancel — the "Keep my account" button;
//   · GET  /api/privacy/export/<reference> — the export download.
//
// Pinned: a bad token changes nothing; one-click answers 200 with no redirect while the page's
// button is redirected back to its confirmation; a cancel never happens on a GET (there is none);
// and a download needs a session, sends a signed-out person to sign in and back, and answers a
// missing export with the same 404 a wrong account gets.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { setPref, cancel, getSession, readExport } = vi.hoisted(() => ({
	setPref: vi.fn(),
	cancel: vi.fn(),
	getSession: vi.fn(),
	readExport: vi.fn(),
}));
vi.mock("@/lib/email/preferences", () => ({
	readUnsubscribeToken: (t: string) => (t === "good" ? { email: "ada@example.io", category: "product_updates" } : null),
	setEmailPreference: (...a: unknown[]) => setPref(...a),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ ok: true, remaining: 10 }) }));
vi.mock("@/lib/privacy/self-deletion", () => ({ cancelScheduledErasure: (...a: unknown[]) => cancel(...a) }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: (...a: unknown[]) => getSession(...a) } } }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/privacy/export", () => ({ readExportForDownload: (...a: unknown[]) => readExport(...a) }));

import { POST as cancelPost } from "@/app/api/account/deletion/cancel/route";
import { POST as unsubscribe } from "@/app/api/email/unsubscribe/route";
import { GET as download } from "@/app/api/privacy/export/[reference]/route";

const ORIGIN = "https://console.example.io";
const TOKEN = "t".repeat(43);

beforeEach(() => {
	for (const m of [setPref, cancel, getSession, readExport]) m.mockReset();
	setPref.mockResolvedValue(undefined);
});

describe("POST /api/email/unsubscribe", () => {
	it("records a one-click unsubscribe and answers 200", async () => {
		const res = await unsubscribe(
			new Request(`${ORIGIN}/api/email/unsubscribe?t=good`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: "List-Unsubscribe=One-Click",
			}),
		);
		expect(res.status).toBe(200);
		expect(setPref).toHaveBeenCalledWith({
			email: "ada@example.io",
			category: "product_updates",
			enabled: false,
			source: "one_click",
		});
	});

	it("sends the confirmation page's button back to the page", async () => {
		const res = await unsubscribe(
			new Request(`${ORIGIN}/api/email/unsubscribe?t=good`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: "from=page",
			}),
		);
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe(`${ORIGIN}/email/unsubscribe?t=good&done=1`);
		expect(setPref).toHaveBeenCalledWith(expect.objectContaining({ source: "unsubscribe_page" }));
	});

	it("changes nothing for a token that does not verify", async () => {
		const res = await unsubscribe(new Request(`${ORIGIN}/api/email/unsubscribe?t=forged`, { method: "POST" }));
		expect(res.status).toBe(400);
		expect(setPref).not.toHaveBeenCalled();
	});
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
