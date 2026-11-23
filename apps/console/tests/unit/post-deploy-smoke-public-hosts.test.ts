// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The post-deploy smoke's `installer` and `status-page` checks (REL-L8, #6909) judge BODIES.
//
// Each case below is a 200 that must still fail — a landing page where the install script should be,
// a frozen status snapshot — because a status-code check passes every one of them. The installer
// signature is also held against the REAL apps/console/public/install.sh and against the status page's
// own Installer row (packages/status/src/probes.ts), so the smoke and the status page cannot come to
// disagree about what the installer host must serve.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertInstaller,
	assertStatusPage,
	assertStatusSummary,
	INSTALLER_MARKERS,
	INSTALLER_SHEBANG,
	STATUS_MAX_AGE_MS,
	type HostResponse,
} from "../../scripts/e2e/public-hosts-check";
// Relative imports into another workspace package, deliberately — the same choice as
// tests/api/health/status-page-monitors.test.ts: this test exists to hold the two sides together.
import {
	assertInstaller as statusPageInstallerRow,
	INSTALLER_MARKERS as STATUS_PAGE_MARKERS,
	INSTALLER_SHEBANG as STATUS_PAGE_SHEBANG,
} from "../../../../packages/status/src/probes";
import { FORCED_REFRESH_MS } from "../../../../packages/status/src/state";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL_SH = readFileSync(join(HERE, "../../public/install.sh"), "utf8");

/** A report that records what each check said. */
function recorder() {
	const r = { fails: [] as string[], warns: [] as string[], notes: [] as string[] };
	return {
		...r,
		/** Records a failure. */
		fail: (why: string) => r.fails.push(why),
		/** Records a warning. */
		warn: (why: string) => r.warns.push(why),
		/** Records a note. */
		note: (what: string) => r.notes.push(what),
	};
}

/** An un-followed answer. */
function answer(status: number, body: string, contentType: string | null, location: string | null = null): HostResponse {
	return { status, body, contentType, location };
}

const NOW = Date.parse("2026-11-23T17:00:00.000Z");

/** A status summary shaped like packages/status/src/worker.ts builds it. */
function summary(over: { [key: string]: unknown } = {}): string {
	return JSON.stringify({
		version: 1,
		generatedAt: "2026-11-23T16:55:00.000Z",
		state: "operational",
		components: [{ id: "console" }, { id: "database" }, { id: "installer" }],
		incidents: [],
		...over,
	});
}

describe("installer: the body is the install script", () => {
	it("passes on the real install.sh, byte-identical to the tree", () => {
		const r = recorder();
		assertInstaller(answer(200, INSTALL_SH, "application/x-sh"), INSTALL_SH, r);
		expect(r.fails).toEqual([]);
		expect(r.notes.join(" ")).toMatch(/byte-identical/);
	});

	it("fails a 200 that serves the landing page", () => {
		const r = recorder();
		assertInstaller(answer(200, "<!DOCTYPE html><html><title>Alethia</title></html>", "text/html; charset=utf-8"), null, r);
		expect(r.fails.join(" ")).toMatch(/text\/html/);
		expect(r.fails.join(" ")).toMatch(/does not start with #!\/bin\/sh/);
	});

	it("fails a shell script that is not this installer", () => {
		const r = recorder();
		assertInstaller(answer(200, "#!/bin/sh\necho hi\n", "application/x-sh"), null, r);
		expect(r.fails.join(" ")).toMatch(/not this installer/);
	});

	it("fails a redirect without following it, naming the target", () => {
		const r = recorder();
		assertInstaller(answer(307, "", null, "https://alethialabs.io/login"), null, r);
		expect(r.fails).toEqual([expect.stringContaining("HTTP 307 → https://alethialabs.io/login")]);
	});

	it("fails when the served bytes differ from the promoted tree", () => {
		const r = recorder();
		assertInstaller(answer(200, `${INSTALL_SH}# drift\n`, "application/x-sh"), INSTALL_SH, r);
		expect(r.fails.join(" ")).toMatch(/differ from the promoted tree/);
	});

	it("without a rebuild, byte equality is NOT ASSERTED — named, not passed silently", () => {
		const r = recorder();
		assertInstaller(answer(200, INSTALL_SH, "application/x-sh"), null, r);
		expect(r.fails).toEqual([]);
		expect(r.notes.join(" ")).toMatch(/NOT ASSERTED/);
	});

	it("the smoke and the status page's Installer row read the same signature", () => {
		expect(INSTALLER_SHEBANG).toBe(STATUS_PAGE_SHEBANG);
		expect(INSTALLER_MARKERS).toEqual(STATUS_PAGE_MARKERS);
		expect(statusPageInstallerRow({ status: 200, body: INSTALL_SH, ms: 1 })).toEqual({ health: "up" });
	});

	it("the real install.sh carries every marker — a marker the file lost would red every deploy", () => {
		expect(INSTALL_SH.startsWith(INSTALLER_SHEBANG)).toBe(true);
		for (const m of INSTALLER_MARKERS) expect(INSTALL_SH).toContain(m);
	});
});

describe("status page: the host answers with a live page", () => {
	it("passes on a fresh operational summary", () => {
		const r = recorder();
		assertStatusSummary(answer(200, summary(), "application/json"), NOW, r);
		expect(r.fails).toEqual([]);
		expect(r.warns).toEqual([]);
	});

	it("fails a 200 whose snapshot is frozen — the Worker's cron stopped", () => {
		const r = recorder();
		assertStatusSummary(answer(200, summary({ generatedAt: "2026-11-23T15:00:00.000Z" }), "application/json"), NOW, r);
		expect(r.fails.join(" ")).toMatch(/cron has stopped/);
	});

	it("a degraded page is a warning, not a failure — that is the page working", () => {
		const r = recorder();
		assertStatusSummary(answer(200, summary({ state: "degraded" }), "application/json"), NOW, r);
		expect(r.fails).toEqual([]);
		expect(r.warns).toEqual(["status.alethialabs.io reports degraded"]);
	});

	it("fails the Worker's no-snapshot 503, a non-JSON body, and a summary missing the installer row", () => {
		const a = recorder();
		assertStatusSummary(answer(503, '{"version":1,"state":"unknown","error":"no snapshot yet"}', "application/json"), NOW, a);
		expect(a.fails).toEqual([expect.stringContaining("HTTP 503")]);

		const b = recorder();
		assertStatusSummary(answer(200, "<html>error</html>", "text/html"), NOW, b);
		expect(b.fails.join(" ")).toMatch(/not JSON/);

		const c = recorder();
		assertStatusSummary(answer(200, summary({ components: [{ id: "console" }] }), "application/json"), NOW, c);
		expect(c.fails.join(" ")).toMatch(/no component installer/);
	});

	it("the staleness allowance outlasts the Worker's forced refresh plus the CDN's cache window", () => {
		// worker.ts CACHE: s-maxage=30, stale-while-revalidate=120.
		expect(STATUS_MAX_AGE_MS).toBeGreaterThan(FORCED_REFRESH_MS + 150_000);
	});

	it("the page passes on the rendered title and fails a placeholder", () => {
		const ok = recorder();
		assertStatusPage(answer(200, "<html><head><title>Alethia Status — All systems operational</title></head></html>", "text/html; charset=utf-8"), ok);
		expect(ok.fails).toEqual([]);

		const placeholder = recorder();
		assertStatusPage(answer(503, "Status data is not available yet.", "text/plain; charset=utf-8"), placeholder);
		expect(placeholder.fails).toEqual([expect.stringContaining("HTTP 503")]);
	});
});
