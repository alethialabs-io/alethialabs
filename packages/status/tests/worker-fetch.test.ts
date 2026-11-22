// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { faviconSvg } from "@repo/brand/icon-svg";
import { describe, expect, it } from "vitest";
import worker, { parseSnapshot, SNAPSHOT_KEY, type StoredSnapshot } from "../src/worker";
import { FakeD1, FakeKV } from "./helpers/fake-bindings";

/** What a request gets. Pure KV read — fetch() never touches D1, which is the CPU-budget split. */

const STORED: StoredSnapshot = { hash: "h", writtenAt: 0, html: "<p>page</p>", summaryJson: '{"version":1}' };

/** GET a path on the status host against a KV holding `stored` (or nothing). */
async function get(path: string, stored: StoredSnapshot | null = STORED): Promise<{ res: Response; body: string }> {
	const kv = new FakeKV();
	if (stored) await kv.put(SNAPSHOT_KEY, JSON.stringify(stored));
	const res = await worker.fetch(new Request(`https://status.alethialabs.io${path}`), {
		DB: new FakeD1(),
		SNAPSHOT: kv,
	});
	return { res, body: await res.text() };
}

describe("fetch()", () => {
	it("serves the page at / from the snapshot, with cache headers", async () => {
		const { res, body } = await get("/");
		expect(res.status).toBe(200);
		expect(body).toBe(STORED.html);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(res.headers.get("cache-control")).toContain("stale-while-revalidate");
	});

	it("serves the summary JSON cross-origin", async () => {
		const { res, body } = await get("/api/summary.json");
		expect(res.status).toBe(200);
		expect(body).toBe(STORED.summaryJson);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});

	it("answers 503 — not an empty 200 — before the first snapshot exists", async () => {
		expect((await get("/", null)).res.status).toBe(503);
		const api = await get("/api/summary.json", null);
		expect(api.res.status).toBe(503);
		expect(JSON.parse(api.body)).toMatchObject({ state: "unknown" });
	});

	it("treats a snapshot of the wrong shape as absent rather than serving it", async () => {
		expect(parseSnapshot('{"hash":"h"}')).toBeNull();
		expect(parseSnapshot("not json")).toBeNull();
		expect(parseSnapshot(JSON.stringify(STORED))).toEqual(STORED);
	});

	it("serves the favicon, robots and sitemap from the Worker itself", async () => {
		const icon = await get("/favicon.svg");
		expect(icon.res.headers.get("content-type")).toContain("image/svg+xml");
		expect(icon.body).toBe(faviconSvg());
		expect((await get("/robots.txt")).body).toContain("Sitemap: https://status.alethialabs.io/sitemap.xml");
		expect((await get("/sitemap.xml")).body).toContain("<loc>https://status.alethialabs.io/</loc>");
	});

	it("404s anything else", async () => {
		expect((await get("/admin")).res.status).toBe(404);
		expect((await get("/api/nope")).res.status).toBe(404);
	});
});
