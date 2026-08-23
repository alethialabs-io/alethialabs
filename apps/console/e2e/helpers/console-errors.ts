// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Console + network error guard. Attaches to a Page and records every console.error, uncaught
// pageerror, and 4xx/5xx response. Specs can assert cleanliness (expectClean) or just read `.errors`
// for the QA report. A small allowlist filters known dev-only noise so real defects stand out.

import { type Page, type Request } from "@playwright/test";

export interface CapturedError {
	kind: "console" | "pageerror" | "response";
	text: string;
	url?: string;
	status?: number;
	at: string;
}

/** Substrings that are known dev-mode noise, not product defects. Keep this list tight. */
const ALLOWLIST: RegExp[] = [
	/Download the React DevTools/i,
	/\[Fast Refresh\]/i,
	/hydration/i, // Next dev hydration warnings are tracked separately; don't fail the whole spec.
	/favicon\.ico/i,
	/react-devtools/i,
	/Warning: .*validateDOMNesting/i,
	/ResizeObserver loop/i,
];

/** Non-error status codes to ignore (auth probes, expected 401 on public checks, etc.). */
function ignorableStatus(status: number, url: string): boolean {
	// 401/403 are frequently expected in negative-auth specs — record but don't treat as noise here;
	// specs that expect them assert explicitly. We only auto-ignore analytics/telemetry beacons.
	if (/\/(_vercel|monitoring|__nextjs)/.test(url)) return true;
	return status < 400;
}

export interface ConsoleGuard {
	errors: CapturedError[];
	/** Errors excluding the allowlist. */
	real(): CapturedError[];
	/** Throws if any non-allowlisted console/pageerror occurred (optionally including >=500 responses). */
	expectClean(opts?: { includeServer5xx?: boolean }): void;
}

function allowed(text: string): boolean {
	return ALLOWLIST.some((re) => re.test(text));
}

/** Attaches error listeners to a page and returns a guard for later assertion/reporting. */
export function attachConsoleGuard(page: Page): ConsoleGuard {
	const errors: CapturedError[] = [];
	page.on("console", (msg) => {
		if (msg.type() !== "error") return;
		const text = msg.text();
		if (allowed(text)) return;
		errors.push({ kind: "console", text, at: new Date().toISOString() });
	});
	page.on("pageerror", (err) => {
		const text = err.message ?? String(err);
		if (allowed(text)) return;
		errors.push({ kind: "pageerror", text, at: new Date().toISOString() });
	});
	page.on("response", (res) => {
		const status = res.status();
		const url = res.url();
		if (ignorableStatus(status, url)) return;
		errors.push({
			kind: "response",
			text: `${status} ${res.request().method()} ${url}`,
			url,
			status,
			at: new Date().toISOString(),
		});
	});
	const guard: ConsoleGuard = {
		errors,
		real: () => errors.filter((e) => !allowed(e.text)),
		expectClean: (opts) => {
			const bad = errors.filter((e) => {
				if (e.kind === "response") {
					if (!opts?.includeServer5xx) return false;
					return (e.status ?? 0) >= 500;
				}
				return true;
			});
			if (bad.length) {
				throw new Error(
					`Console/page errors detected (${bad.length}):\n` +
						bad.map((e) => ` · [${e.kind}] ${e.text}`).join("\n"),
				);
			}
		},
	};
	return guard;
}
