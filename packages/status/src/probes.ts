// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What status.alethialabs.io measures, and how it decides a thing is broken.
 *
 * This file is the single source of truth for the page and the JSON API. Everything downstream
 * renders what these specs say.
 *
 * TWO IDEAS, DELIBERATELY SEPARATE
 *
 *   ENDPOINT  — a URL we fetch. Fetched exactly ONCE per probe cycle.
 *   COMPONENT — a row on the page, evaluated against an endpoint's result.
 *
 * Three components (Console, Database, Authorization) read the SAME endpoint. Fetching
 * `alethialabs.io/api/health` once and evaluating three assertions against it is cheaper, and more
 * honest, than three requests that could each catch a different instant.
 *
 * WHY THE ASSERTIONS PARSE THE BODY INSTEAD OF TRUSTING THE STATUS CODE
 *
 * The console's readiness route (apps/console/app/api/health/route.ts) answers **200 for `degraded`**
 * on purpose — a stuck background loop must not make the load balancer drain every instance. So a
 * status-code check reads "operational" straight through a degradation. And a database that is
 * reachable but EMPTY (a cluster restored without its schema) passes `SELECT 1`: TOVR's status page,
 * which this one is ported from, documented exactly that outage — the health endpoint answered "ok"
 * for two days against a schema-less cluster. Hence `checks.schema` is asserted separately from
 * `checks.db`, and both come from the body.
 *
 * The assertions parse JSON rather than substring-match the body. A substring check would pass on
 * `"db":true` appearing anywhere, and would silently start returning "up" the day the payload gains a
 * field.
 *
 * THE PROBE CREDENTIAL
 *
 * Anonymous callers of /api/health get only `{status, mode, ts}`. The per-component booleans
 * (`checks.db`, `checks.schema`, `checks.openfga`) are returned only to a caller presenting
 * `Authorization: Bearer <ALETHIA_STATUS_PROBE_TOKEN>`; the Worker holds that value as the secret
 * binding `STATUS_PROBE_TOKEN`. Without it the Database and Authorization rows read `degraded` with a
 * reason that names the missing credential — "I could not tell" is never reported as "it is fine".
 */

/** A component's health. `degraded` means reachable but not in the state it must be in. */
export type Health = "up" | "degraded" | "down";

/** Secrets the probes need. An absent value is handled by the assertions, never assumed. */
export interface ProbeEnv {
	/** Must equal the console's ALETHIA_STATUS_PROBE_TOKEN. */
	STATUS_PROBE_TOKEN?: string;
}

/** One URL fetched per cycle. */
export interface EndpointSpec {
	key: string;
	url: string;
	/** Built per cycle so a rotated secret is picked up without a redeploy. */
	headers?: (env: ProbeEnv) => Record<string, string>;
}

/**
 * The outcome of one fetch. `status: 0` means the fetch itself threw — DNS, TLS, timeout.
 * `location` is the redirect target when the answer was a 3xx (redirects are never followed).
 */
export interface EndpointResult {
	status: number;
	body: string;
	ms: number;
	location?: string;
	error?: string;
}

/** An assertion's verdict. `reason` is shown on the page and must name the actual failure. */
export interface Verdict {
	health: Health;
	reason?: string;
}

/** One row on the page. */
export interface ComponentSpec {
	/** Stable slug. It is the JSON contract key — renaming one breaks every consumer. */
	id: string;
	name: string;
	/** What a reader actually loses while this is down. */
	description: string;
	endpoint: string;
	/**
	 * `true` when this being down means the product is unusable, not merely diminished. Only these
	 * can push the whole page to `outage`.
	 */
	critical: boolean;
	assert: (r: EndpointResult) => Verdict;
}

// ── endpoints ───────────────────────────────────────────────────────────────

/** Where the console and the public site are served. */
export const ORIGIN = "https://alethialabs.io";

/** The bearer the console's /api/health accepts for the per-component booleans, when we hold it. */
function probeHeaders(env: ProbeEnv): Record<string, string> {
	return env.STATUS_PROBE_TOKEN ? { authorization: `Bearer ${env.STATUS_PROBE_TOKEN}` } : {};
}

/**
 * Every endpoint is judged WITHOUT following redirects, and that is measured rather than assumed.
 * On 2026-11-21 `alethialabs.io/news` answered `307 → /login?next=%2Fnews` (the route was not deployed
 * yet, so the console's auth middleware claimed the path). A probe that followed it would have landed
 * on the sign-in page, read 200, and reported News operational. A redirect is reported as down, with
 * its target in the reason, so the row says what actually answered.
 */
export const ENDPOINTS: EndpointSpec[] = [
	{ key: "console-health", url: `${ORIGIN}/api/health`, headers: probeHeaders },
	{ key: "website", url: `${ORIGIN}/` },
	{ key: "docs", url: `${ORIGIN}/docs` },
	{ key: "news", url: `${ORIGIN}/news` },
	{ key: "installer", url: "https://get.alethialabs.io/" },
];

// ── reading the console's health body ───────────────────────────────────────

/** What the console's health route says, narrowed from its JSON. Null fields were absent or malformed. */
export interface ConsoleHealthBody {
	/** healthy | degraded | unhealthy — or any other string the route might grow. */
	status: string | null;
	/** The per-component booleans; null when the route did not disclose them. */
	checks: { db: boolean | null; schema: boolean | null; openfga: boolean | null | undefined } | null;
}

/** True for a plain JSON object. */
function isObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A boolean field, or null when absent or not a boolean. */
function bool(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

/**
 * Parse the console's health body. Null when it is not JSON at all — a proxy error page, a
 * maintenance banner. Null is NOT treated as healthy anywhere below: an unparseable body from an
 * endpoint whose whole job is to be parseable is itself a fault.
 *
 * `openfga` keeps three meanings apart: `true`/`false` (the engine answered or did not), `null` (the
 * console runs without OpenFGA — authorization is the Postgres engine), and `undefined` (the key is
 * missing, so we cannot tell).
 */
export function readConsoleHealth(body: string): ConsoleHealthBody | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	if (!isObject(parsed)) return null;
	const status = typeof parsed.status === "string" ? parsed.status : null;
	const raw = parsed.checks;
	if (!isObject(raw)) return { status, checks: null };
	const openfga = !("openfga" in raw) ? undefined : raw.openfga === null ? null : bool(raw.openfga);
	return { status, checks: { db: bool(raw.db), schema: bool(raw.schema), openfga } };
}

// ── assertion helpers ───────────────────────────────────────────────────────

const UP: Verdict = { health: "up" };

/** The reason shown when the console answered but withheld the per-component booleans. */
export const NO_CREDENTIAL = "health detail withheld: the probe credential was not accepted";

/** Transport-level failure, shared by every assertion. Null when we got a response. */
function transportFailure(r: EndpointResult): Verdict | null {
	if (r.status === 0) return { health: "down", reason: r.error ?? "unreachable" };
	return null;
}

/** `HTTP 307 → https://…` for a redirect, `HTTP 503` otherwise. */
function httpReason(r: EndpointResult): string {
	return r.location ? `HTTP ${r.status} → ${r.location}` : `HTTP ${r.status}`;
}

/** The default for a page: 2xx is up, everything else (a redirect included) is down. */
export function statusOnly(r: EndpointResult): Verdict {
	const t = transportFailure(r);
	if (t) return t;
	return r.status >= 200 && r.status < 300 ? UP : { health: "down", reason: httpReason(r) };
}

/**
 * What the installer body must carry beyond starting with `#!/bin/sh`: two lines of
 * apps/console/public/install.sh that name THIS product's installer. The post-deploy smoke
 * (apps/console/scripts/e2e/public-hosts-check.ts) reads the same markers; its unit test holds the two
 * lists equal and runs both against the real file.
 */
export const INSTALLER_SHEBANG = "#!/bin/sh";
export const INSTALLER_MARKERS = ["Alethia CLI installer", 'REPO="alethialabs-io/alethia-cli"'];

/**
 * The Installer row: 2xx is necessary, not sufficient. get.alethialabs.io is a rewrite to the
 * console's /install.sh (deploy/prod/Caddyfile.tunnel, apps/console/next.config.ts); a routing
 * regression answers 200 with a web page, and `curl … | sh` would pipe that into a shell. So the body
 * must BE the install script. A 2xx that is not is reported down, with what it was instead.
 */
export function assertInstaller(r: EndpointResult): Verdict {
	const page = statusOnly(r);
	if (page.health !== "up") return page;
	if (!r.body.startsWith(INSTALLER_SHEBANG)) {
		return { health: "down", reason: `HTTP ${r.status} but not the install script (starts ${JSON.stringify(r.body.slice(0, 24))})` };
	}
	const missing = INSTALLER_MARKERS.filter((m) => !r.body.includes(m));
	if (missing.length > 0) return { health: "down", reason: "a shell script, but not the Alethia installer" };
	return UP;
}

/**
 * The console row: the aggregate `status` off the body. The route answers 503 for `unhealthy` and 200
 * for `degraded`, so the body — not the code — is what separates degraded from healthy.
 */
export function assertConsole(r: EndpointResult): Verdict {
	const t = transportFailure(r);
	if (t) return t;
	const body = readConsoleHealth(r.body);
	if (body?.status === "healthy") return UP;
	if (body?.status === "degraded") return { health: "degraded", reason: "a background loop is behind" };
	if (body?.status === "unhealthy") return { health: "down", reason: "the console reports unhealthy" };
	if (r.status < 200 || r.status >= 300) return { health: "down", reason: httpReason(r) };
	return {
		health: "degraded",
		reason: body ? `unexpected status: ${String(body.status)}` : "unreadable health payload",
	};
}

/**
 * The shared shape of the two detail rows: the checks must be present before anything can be said.
 * An `unhealthy` 503 still carries them, so they are read before the status code is judged.
 */
function withChecks(
	r: EndpointResult,
	judge: (checks: NonNullable<ConsoleHealthBody["checks"]>) => Verdict,
): Verdict {
	const t = transportFailure(r);
	if (t) return t;
	const body = readConsoleHealth(r.body);
	if (body?.checks) return judge(body.checks);
	if (r.status < 200 || r.status >= 300) return { health: "down", reason: httpReason(r) };
	if (!body) return { health: "degraded", reason: "unreadable health payload" };
	return { health: "degraded", reason: NO_CREDENTIAL };
}

/**
 * Postgres: reachable AND provisioned. `db` alone answers "can we connect"; `schema` answers "is this
 * a cluster with our tables in it". A missing boolean is `degraded` with the raw value, never `up`.
 */
export function assertDatabase(r: EndpointResult): Verdict {
	return withChecks(r, (checks) => databaseVerdict(checks.db, checks.schema));
}

/** The database verdict from its two booleans. Shared with the Authorization row's Postgres engine. */
function databaseVerdict(db: boolean | null, schema: boolean | null): Verdict {
	if (db === false) return { health: "down", reason: "db: unreachable" };
	if (db === null) return { health: "degraded", reason: "db: missing" };
	if (schema === false) return { health: "down", reason: "schema: missing" };
	if (schema === null) return { health: "degraded", reason: "schema: missing from the health payload" };
	return UP;
}

/**
 * Authorization. With OpenFGA configured the engine is a separate server, judged on its own boolean.
 * Without it (`openfga: null`) the policy engine is PostgresRbacPDP — so authorization works exactly
 * when the database does, and the row says so rather than reporting a server that does not exist.
 */
export function assertAuthorization(r: EndpointResult): Verdict {
	return withChecks(r, (checks) => {
		if (checks.openfga === true) return UP;
		if (checks.openfga === false) return { health: "down", reason: "openfga: unreachable" };
		if (checks.openfga === undefined) return { health: "degraded", reason: "openfga: missing" };
		const v = databaseVerdict(checks.db, checks.schema);
		return v.health === "up" ? v : { health: v.health, reason: `postgres engine — ${v.reason ?? ""}` };
	});
}

// ── components ──────────────────────────────────────────────────────────────

export const COMPONENTS: ComponentSpec[] = [
	{
		id: "console",
		name: "Console",
		description: "The control plane — sign-in, projects, plans and deploys.",
		endpoint: "console-health",
		critical: true,
		assert: assertConsole,
	},
	{
		id: "database",
		name: "Database",
		description: "Postgres — every project, environment and run record.",
		endpoint: "console-health",
		critical: true,
		assert: assertDatabase,
	},
	{
		id: "authorization",
		name: "Authorization",
		description: "The policy engine — who may see and change what.",
		endpoint: "console-health",
		critical: true,
		assert: assertAuthorization,
	},
	{
		id: "website",
		name: "Website",
		description: "alethialabs.io.",
		endpoint: "website",
		critical: false,
		assert: statusOnly,
	},
	{
		id: "docs",
		name: "Docs",
		description: "alethialabs.io/docs.",
		endpoint: "docs",
		critical: false,
		assert: statusOnly,
	},
	{
		id: "news",
		name: "News",
		description: "alethialabs.io/news.",
		endpoint: "news",
		critical: false,
		assert: statusOnly,
	},
	{
		id: "installer",
		name: "Installer",
		description: "get.alethialabs.io — the CLI install script.",
		endpoint: "installer",
		critical: false,
		assert: assertInstaller,
	},
];

// ── rollup ──────────────────────────────────────────────────────────────────

/** The one-line verdict the page banner shows. */
export type OverallState = "operational" | "degraded" | "outage";

/** Roll component healths into the banner: a critical row down is an outage; anything else not up is degraded. */
export function rollUp(components: { id: string; health: Health }[]): OverallState {
	const critical = new Set(COMPONENTS.filter((c) => c.critical).map((c) => c.id));
	let degraded = false;
	for (const c of components) {
		if (c.health === "down") {
			if (critical.has(c.id)) return "outage";
			degraded = true;
		} else if (c.health === "degraded") {
			degraded = true;
		}
	}
	return degraded ? "degraded" : "operational";
}
