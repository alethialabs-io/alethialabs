// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The post-deploy smoke's `installer` and `status-page` checks (REL-L8, #6909), separated from the
// script so a unit test can run them — the same split as build-id-check.ts, for the same reason:
// post-deploy-smoke.ts calls `main()` at import time.
//
// # What these two checks are for
//
// Beta predicate B7's "public hosts" part (docs/beta/README.md) reads the newest production deploy's
// smoke, and it names two hosts the console smoke never visited: the CLI installer
// (get.alethialabs.io) and the status page (status.alethialabs.io). Both are judged on their BODIES:
//
//   - get.alethialabs.io is routed by deploy/prod/Caddyfile.tunnel to the console, whose
//     next.config.ts rewrites `/` to /install.sh. A routing regression there answers 200 with the
//     marketing landing page — a perfectly healthy status code that `curl … | sh` would pipe into a
//     shell. So 200 is necessary and nowhere near sufficient: the body must BE the install script.
//   - status.alethialabs.io is a Cloudflare Worker (packages/status) that serves a KV snapshot. A
//     Worker whose cron stopped keeps serving the last snapshot forever with a 200, so the summary's
//     `generatedAt` must be recent, not merely present.
//
// Neither check needs a browser, and neither sends a credential: both hosts are public.

/** The CLI installer host. `/` is the POSIX install script. */
export const INSTALLER_URL = "https://get.alethialabs.io/";

/** The status host's machine-readable summary (packages/status/src/worker.ts `/api/summary.json`). */
export const STATUS_SUMMARY_URL = "https://status.alethialabs.io/api/summary.json";

/** The status host's page. */
export const STATUS_PAGE_URL = "https://status.alethialabs.io/";

/**
 * What the served installer must contain, beyond starting with a POSIX shebang. Each is a line of
 * apps/console/public/install.sh that names THIS product's installer — a generic shell script, or a
 * different product's, matches none of them. packages/status/src/probes.ts `INSTALLER_MARKERS` reads
 * the same markers for the status page's Installer row; the unit test holds the two lists equal and
 * runs both against the real file.
 */
export const INSTALLER_SHEBANG = "#!/bin/sh";
export const INSTALLER_MARKERS = ["Alethia CLI installer", 'REPO="alethialabs-io/alethia-cli"'];

/**
 * How old the status summary may be before the page is called stale.
 *
 * The Worker rewrites its snapshot on any change and otherwise every `FORCED_REFRESH_MS` (10 min,
 * packages/status/src/state.ts), and the CDN may serve it for `s-maxage` 30 s plus
 * `stale-while-revalidate` 120 s on top (worker.ts `CACHE`). So a healthy page is at most ~12.5 min
 * old. Twenty leaves room for one missed cron tick without calling it stale; the unit test fails if
 * the Worker's refresh interval grows past this allowance.
 */
export const STATUS_MAX_AGE_MS = 20 * 60 * 1000;

/** A future `generatedAt` beyond this is a clock or contract fault, not freshness. */
const STATUS_MAX_SKEW_MS = 5 * 60 * 1000;

/** The overall states the status page reports (packages/status/src/probes.ts `OverallState`). */
const OVERALL_STATES = ["operational", "degraded", "outage"];

/** Component ids the summary must carry — the two this check exists for, plus the console. */
const REQUIRED_COMPONENTS = ["console", "installer"];

/** One un-followed HTTP answer, as the smoke fetched it. */
export interface HostResponse {
	status: number;
	/** The `content-type` header, or null when absent. */
	contentType: string | null;
	body: string;
	/** The `location` header on a 3xx — redirects are never followed. */
	location: string | null;
}

/** Where a check reports: `fail` reds the smoke, `warn` annotates it, `note` records what was seen. */
export interface HostReport {
	fail(why: string): void;
	warn(why: string): void;
	note(what: string): void;
}

/** `HTTP 307 → https://…` for a redirect, `HTTP 503` otherwise. */
function httpReason(r: HostResponse): string {
	return r.location ? `HTTP ${r.status} → ${r.location}` : `HTTP ${r.status}`;
}

/** The first bytes of a body, quoted, for a failure line — enough to recognise, never the whole page. */
function head(body: string): string {
	return JSON.stringify(body.slice(0, 40));
}

/**
 * Asserts get.alethialabs.io serves the CLI install script.
 *
 * `treeScript` is the promoted tree's apps/console/public/install.sh when the deploy rebuilt the apps
 * image group, so the served bytes must equal it exactly; null when it did not (a retagged image
 * carries the PREVIOUS build's file), which is reported as not asserted, never as a pass. The
 * signature checks run either way.
 */
export function assertInstaller(r: HostResponse, treeScript: string | null, report: HostReport): void {
	if (r.status !== 200) {
		report.fail(`${INSTALLER_URL} answered ${httpReason(r)}, expected 200 with the install script`);
		return;
	}
	if (r.contentType?.toLowerCase().includes("text/html")) {
		report.fail(
			`${INSTALLER_URL} answered text/html — the edge served a web page where \`curl … | sh\` expects the install script`,
		);
	}
	if (!r.body.startsWith(INSTALLER_SHEBANG)) {
		report.fail(`${INSTALLER_URL} body does not start with ${INSTALLER_SHEBANG}; it starts ${head(r.body)}`);
		return;
	}
	const missing = INSTALLER_MARKERS.filter((m) => !r.body.includes(m));
	if (missing.length > 0) {
		report.fail(`${INSTALLER_URL} body is a shell script but not this installer: missing ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
		return;
	}
	report.note(`install script signature present (${r.body.length} bytes)`);

	if (treeScript === null) {
		report.note("byte equality with the promoted tree NOT ASSERTED — the apps images were retagged, not rebuilt");
	} else if (r.body !== treeScript) {
		report.fail(
			`${INSTALLER_URL} serves ${r.body.length} bytes that differ from the promoted tree's apps/console/public/install.sh (${treeScript.length} bytes)`,
		);
	} else {
		report.note("byte-identical to the promoted tree's install.sh");
	}
}

/** A plain JSON object. */
function isObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Asserts status.alethialabs.io's summary answers, parses, carries the components it must, and is
 * fresh at `nowMs`.
 *
 * A non-`operational` overall state is a WARNING, not a failure: the status page reporting a degraded
 * row is the page working. What this measures is that the HOST answers with a live page.
 */
export function assertStatusSummary(r: HostResponse, nowMs: number, report: HostReport): void {
	if (r.status !== 200) {
		report.fail(`${STATUS_SUMMARY_URL} answered ${httpReason(r)}, expected 200`);
		return;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(r.body);
	} catch {
		report.fail(`${STATUS_SUMMARY_URL} body is not JSON; it starts ${head(r.body)}`);
		return;
	}
	if (!isObject(parsed)) {
		report.fail(`${STATUS_SUMMARY_URL} body is not a JSON object`);
		return;
	}
	if (typeof parsed.version !== "number") {
		report.fail(`${STATUS_SUMMARY_URL} carries no numeric \`version\``);
	}
	const state = parsed.state;
	if (typeof state !== "string" || !OVERALL_STATES.includes(state)) {
		report.fail(`${STATUS_SUMMARY_URL} state is ${JSON.stringify(state)}, expected one of ${OVERALL_STATES.join("/")}`);
	}

	const ids = Array.isArray(parsed.components)
		? parsed.components.flatMap((c) => (isObject(c) && typeof c.id === "string" ? [c.id] : []))
		: [];
	const absent = REQUIRED_COMPONENTS.filter((id) => !ids.includes(id));
	if (absent.length > 0) report.fail(`${STATUS_SUMMARY_URL} has no component ${absent.join(", ")}`);

	const generatedAt = typeof parsed.generatedAt === "string" ? Date.parse(parsed.generatedAt) : Number.NaN;
	if (Number.isNaN(generatedAt)) {
		report.fail(`${STATUS_SUMMARY_URL} generatedAt is ${JSON.stringify(parsed.generatedAt)}, not a timestamp`);
		return;
	}
	const ageMs = nowMs - generatedAt;
	const ageMin = (ageMs / 60_000).toFixed(1);
	if (ageMs > STATUS_MAX_AGE_MS) {
		report.fail(
			`${STATUS_SUMMARY_URL} was generated ${ageMin} min ago (limit ${STATUS_MAX_AGE_MS / 60_000}) — the Worker's cron has stopped and the page is frozen`,
		);
	} else if (ageMs < -STATUS_MAX_SKEW_MS) {
		report.fail(`${STATUS_SUMMARY_URL} generatedAt ${String(parsed.generatedAt)} is in the future`);
	} else {
		report.note(`generated ${ageMin} min ago`);
	}

	if (typeof state === "string" && state !== "operational" && OVERALL_STATES.includes(state)) {
		report.warn(`status.alethialabs.io reports ${state}`);
	} else if (state === "operational") {
		report.note("state: operational");
	}
}

/** Asserts status.alethialabs.io's page renders the status page itself, not an error or a placeholder. */
export function assertStatusPage(r: HostResponse, report: HostReport): void {
	if (r.status !== 200) {
		report.fail(`${STATUS_PAGE_URL} answered ${httpReason(r)}, expected 200`);
		return;
	}
	if (!r.contentType?.toLowerCase().includes("text/html")) {
		report.fail(`${STATUS_PAGE_URL} answered ${r.contentType ?? "no content-type"}, expected text/html`);
		return;
	}
	// packages/status/src/render.ts titles every state `Alethia Status — <banner>`.
	const title = /<title>([^<]*)<\/title>/.exec(r.body)?.[1] ?? null;
	if (!title?.startsWith("Alethia Status")) {
		report.fail(`${STATUS_PAGE_URL} title is ${JSON.stringify(title)}, expected "Alethia Status — …"`);
		return;
	}
	report.note(`title: ${JSON.stringify(title.slice(0, 60))}`);
}
