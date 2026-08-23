// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Latency collector. Attaches to a Page and records timing for document navigations, server-action
// POSTs, and API fetches. Records are attached to each test as a JSON attachment (qa-perf) and rolled
// up by e2e/reporters/qa-reporter.ts into test-results/qa-report.json. Perf numbers meant for the
// report should come from the serial (workers=1) pass — the parallel correctness run adds load noise.

import { type Page } from "@playwright/test";

export interface PerfRecord {
	/** "navigation" (top-level document), "server-action" (Next action POST), or "fetch". */
	kind: "navigation" | "server-action" | "fetch";
	method: string;
	/** Path only (query + origin stripped) so records group cleanly across orgs/runs. */
	path: string;
	status: number;
	/** Wall-clock duration in ms (responseEnd − requestStart from the resource timing). */
	durationMs: number;
	at: string;
}

export interface PerfCollector {
	records: PerfRecord[];
}

/** Strips origin + query so /{org}/~/settings/billing?x=1 → /:org/~/settings/billing. */
function normalizePath(rawUrl: string): string {
	try {
		const u = new URL(rawUrl);
		// Collapse the first path segment (org slug) and any uuid-ish segments to placeholders.
		const parts = u.pathname.split("/").map((seg) => {
			if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return ":id";
			return seg;
		});
		if (parts.length > 1 && parts[1] && parts[1] !== "~" && parts[1] !== "api") parts[1] = ":org";
		return parts.join("/") || "/";
	} catch {
		return rawUrl;
	}
}

/** Attaches request timing listeners to a page and returns a collector of PerfRecords. */
export function attachPerf(page: Page): PerfCollector {
	const records: PerfRecord[] = [];
	page.on("requestfinished", async (request) => {
		try {
			const timing = request.timing();
			const response = await request.response();
			if (!response) return;
			const type = request.resourceType();
			const method = request.method();
			// Next server actions: POST to a page route carrying the Next-Action header.
			const headers = request.headers();
			const isAction = method === "POST" && ("next-action" in headers || "next-router-state-tree" in headers);
			let kind: PerfRecord["kind"];
			if (type === "document") kind = "navigation";
			else if (isAction) kind = "server-action";
			else if (type === "fetch" || type === "xhr") kind = "fetch";
			else return; // ignore static assets / images / fonts
			const durationMs = timing.responseEnd >= 0 ? Math.round(timing.responseEnd) : -1;
			records.push({
				kind,
				method,
				path: normalizePath(request.url()),
				status: response.status(),
				durationMs,
				at: new Date().toISOString(),
			});
		} catch {
			// timing/response can race teardown; drop silently.
		}
	});
	return { records };
}
