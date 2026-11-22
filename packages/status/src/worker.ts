// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * status.alethialabs.io — the Worker.
 *
 * WHY THIS RUNS AT CLOUDFLARE AND NOT ON OUR BOX
 *
 * A status page inside the failure domain it reports on goes silent in exactly the incident it exists
 * for. This runs at the edge, so a total outage of the control-plane box is the case it REPORTS
 * rather than the case that takes it down too.
 *
 * TWO HALVES, AND THE SPLIT IS A CPU BUDGET
 *
 *   scheduled() — probes everything, writes D1, and renders a snapshot into KV. A cron invocation
 *                 gets seconds of CPU, and waiting on the network is I/O, not CPU.
 *
 *   fetch()     — reads ONE KV key and returns a slice of it. The free plan caps an HTTP request at
 *                 10 ms CPU, which rules out querying D1 and templating a page per request.
 *
 * The snapshot is one KV key rather than several because KV writes are the real free-tier ceiling
 * (1000/day) — see `shouldWriteSnapshot` in `state.ts`.
 */

import type { D1Database, D1PreparedStatement, ExecutionContext, KVNamespace, Row, ScheduledController } from "./bindings";
import { COMPONENTS, ENDPOINTS, rollUp, type EndpointResult, type Health, type ProbeEnv, type Verdict } from "./probes";
import { FAVICON_SVG, SITE, renderPage } from "./render";
import { SCHEMA_STATEMENTS } from "./schema";
import {
	SUMMARY_VERSION,
	decideIncident,
	shouldWriteSnapshot,
	snapshotHash,
	uptimeFraction,
	type ComponentSummary,
	type DayRollup,
	type IncidentSummary,
	type Summary,
} from "./state";

/** The Worker's bindings: D1 history, the KV snapshot, and the probe secret. */
export interface Env extends ProbeEnv {
	DB: D1Database;
	SNAPSHOT: KVNamespace;
}

export const SNAPSHOT_KEY = "snapshot";
const PROBE_TIMEOUT_MS = 8_000;
/** `checks` only feeds the incident state machine; an hour is generous for that. */
const CHECKS_RETENTION_S = 3600;
const HISTORY_DAYS = 90;
/** A probe body larger than this is cut: the assertions need the health JSON, not a whole page. */
const MAX_BODY_CHARS = 64_000;

/** What KV holds: the rendered page, the JSON, and the two facts the write gate needs. */
export interface StoredSnapshot {
	hash: string;
	writtenAt: number;
	html: string;
	summaryJson: string;
}

/** Parse the stored snapshot, or null when it is absent or not the shape this Worker writes. */
export function parseSnapshot(raw: string | null): StoredSnapshot | null {
	if (raw === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const hash = "hash" in parsed ? parsed.hash : undefined;
	const writtenAt = "writtenAt" in parsed ? parsed.writtenAt : undefined;
	const html = "html" in parsed ? parsed.html : undefined;
	const summaryJson = "summaryJson" in parsed ? parsed.summaryJson : undefined;
	if (typeof hash !== "string" || typeof writtenAt !== "number") return null;
	if (typeof html !== "string" || typeof summaryJson !== "string") return null;
	return { hash, writtenAt, html, summaryJson };
}

// ── row readers ─────────────────────────────────────────────────────────────
//
// D1 returns whatever SQLite holds. These narrow each column instead of trusting a type parameter,
// so a schema drift surfaces as a reading of `degraded` with a named reason, never as a crash.

/** A TEXT column, or the fallback. */
function text(row: Row, key: string, fallback = ""): string {
	const v = row[key];
	return typeof v === "string" ? v : fallback;
}

/** A nullable TEXT column. */
function textOrNull(row: Row, key: string): string | null {
	const v = row[key];
	return typeof v === "string" ? v : null;
}

/** An INTEGER column, or the fallback. */
function int(row: Row, key: string, fallback = 0): number {
	const v = row[key];
	return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : fallback;
}

/** A nullable INTEGER column. */
function intOrNull(row: Row, key: string): number | null {
	const v = row[key];
	return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : null;
}

/** A health column; anything unrecognised reads as degraded, never as up. */
function health(row: Row, key: string): Health {
	const v = row[key];
	return v === "up" || v === "down" || v === "degraded" ? v : "degraded";
}

// ── probing ─────────────────────────────────────────────────────────────────

/**
 * One fetch per endpoint. A thrown fetch becomes `status: 0` rather than propagating: one unreachable
 * host must not abort the other probes and leave the page frozen on stale data. Redirects are never
 * followed — see `ENDPOINTS` in probes.ts.
 */
async function probe(env: Env): Promise<Record<string, EndpointResult>> {
	const entries = await Promise.all(
		ENDPOINTS.map(async (e): Promise<[string, EndpointResult]> => {
			const started = Date.now();
			try {
				const res = await fetch(e.url, {
					headers: { "user-agent": "alethia-status/1", ...(e.headers?.(env) ?? {}) },
					redirect: "manual",
					signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
				});
				// Read the body always: the assertions that matter most are body assertions, and an unread
				// body is indistinguishable from an empty one.
				const body = (await res.text()).slice(0, MAX_BODY_CHARS);
				const location = res.headers.get("location");
				const result: EndpointResult = { status: res.status, body, ms: Date.now() - started };
				if (location) result.location = location;
				return [e.key, result];
			} catch (err) {
				return [
					e.key,
					{
						status: 0,
						body: "",
						ms: Date.now() - started,
						error: err instanceof Error ? err.message : "fetch failed",
					},
				];
			}
		}),
	);
	return Object.fromEntries(entries);
}

// ── the cycle ───────────────────────────────────────────────────────────────

/** Isolates that have already applied the schema. Per isolate, so a fresh database needs no human step. */
const schemaApplied = new WeakSet<D1Database>();

/** Apply the schema once per isolate and database (`IF NOT EXISTS` throughout, so a re-run is a no-op). */
async function ensureSchema(db: D1Database): Promise<void> {
	if (schemaApplied.has(db)) return;
	await db.batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s)));
	schemaApplied.add(db);
}

/** One probe cycle: probe, record, decide incidents, and refresh the snapshot when it changed. */
export async function runCycle(env: Env, nowMs: number): Promise<void> {
	await ensureSchema(env.DB);
	const results = await probe(env);
	const ts = Math.floor(nowMs / 1000);
	const day = new Date(nowMs).toISOString().slice(0, 10);

	const evaluated = COMPONENTS.map((c) => {
		const r = results[c.endpoint];
		// A component whose endpoint is missing is a wiring bug, not an outage — but it must not read
		// as healthy either.
		const verdict: Verdict = r ? c.assert(r) : { health: "degraded", reason: "no probe result" };
		return { id: c.id, health: verdict.health, reason: verdict.reason ?? null, ms: r?.ms ?? null };
	});

	// Record first, so the incident decision below reads a window that includes this cycle.
	await env.DB.batch([
		...evaluated.map((e) =>
			env.DB.prepare("INSERT OR REPLACE INTO checks (component, ts, health, ms, reason) VALUES (?, ?, ?, ?, ?)").bind(
				e.id,
				ts,
				e.health,
				e.ms,
				e.reason,
			),
		),
		...evaluated.map((e) =>
			env.DB.prepare(
				`INSERT INTO daily (component, day, total, up) VALUES (?, ?, 1, ?)
				 ON CONFLICT (component, day) DO UPDATE SET total = total + 1, up = up + excluded.up`,
			).bind(e.id, day, e.health === "up" ? 1 : 0),
		),
		env.DB.prepare("DELETE FROM checks WHERE ts < ?").bind(ts - CHECKS_RETENTION_S),
	]);

	await applyIncidents(env, evaluated, ts);
	await writeSnapshot(env, nowMs);
}

/** Open, escalate or resolve each component's incident from its recent checks. */
async function applyIncidents(env: Env, evaluated: { id: string }[], ts: number): Promise<void> {
	const open = await env.DB.prepare("SELECT id, component, worst FROM incidents WHERE resolved_at IS NULL").all();
	const openBy = new Map(
		open.results.map((row) => [text(row, "component"), { id: int(row, "id"), worst: health(row, "worst") }]),
	);

	const recent = await env.DB.prepare("SELECT component, health, reason FROM checks WHERE ts >= ? ORDER BY ts DESC")
		.bind(ts - 600)
		.all();
	const byComponent = new Map<string, { health: Health; reason: string | null }[]>();
	for (const row of recent.results) {
		const key = text(row, "component");
		const list = byComponent.get(key) ?? [];
		list.push({ health: health(row, "health"), reason: textOrNull(row, "reason") });
		byComponent.set(key, list);
	}

	const statements: D1PreparedStatement[] = [];
	for (const e of evaluated) {
		const incident = openBy.get(e.id) ?? null;
		const action = decideIncident({
			recent: byComponent.get(e.id) ?? [],
			openIncident: incident ? { worst: incident.worst } : null,
		});
		if (action.kind === "open") {
			statements.push(
				env.DB.prepare("INSERT INTO incidents (component, started_at, worst, reason) VALUES (?, ?, ?, ?)").bind(
					e.id,
					ts,
					action.worst,
					action.reason,
				),
			);
		} else if (action.kind === "escalate" && incident) {
			statements.push(
				env.DB.prepare("UPDATE incidents SET worst = ?, reason = ? WHERE id = ?").bind(
					action.worst,
					action.reason,
					incident.id,
				),
			);
		} else if (action.kind === "resolve" && incident) {
			statements.push(env.DB.prepare("UPDATE incidents SET resolved_at = ? WHERE id = ?").bind(ts, incident.id));
		}
	}
	if (statements.length) await env.DB.batch(statements);
}

// ── snapshot ────────────────────────────────────────────────────────────────

/** Build the public summary from D1: latest check per component, 90 days of rollups, the last 40 incidents. */
async function buildSummary(env: Env, nowMs: number): Promise<Summary> {
	const since = new Date(nowMs - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);

	const [latest, history, incidents] = await Promise.all([
		env.DB.prepare(
			`SELECT c.component, c.health, c.ms, c.reason
			   FROM checks c
			   JOIN (SELECT component, MAX(ts) AS ts FROM checks GROUP BY component) m
			     ON m.component = c.component AND m.ts = c.ts`,
		).all(),
		env.DB.prepare("SELECT component, day, total, up FROM daily WHERE day >= ? ORDER BY day ASC").bind(since).all(),
		env.DB.prepare(
			"SELECT id, component, started_at, resolved_at, worst, reason FROM incidents ORDER BY started_at DESC LIMIT 40",
		).all(),
	]);

	const latestBy = new Map(latest.results.map((r) => [text(r, "component"), r]));
	const historyBy = new Map<string, DayRollup[]>();
	for (const row of history.results) {
		const key = text(row, "component");
		const list = historyBy.get(key) ?? [];
		list.push({ day: text(row, "day"), total: int(row, "total"), up: int(row, "up") });
		historyBy.set(key, list);
	}

	const components: ComponentSummary[] = COMPONENTS.map((c) => {
		const last = latestBy.get(c.id);
		const days = historyBy.get(c.id) ?? [];
		return {
			id: c.id,
			name: c.name,
			description: c.description,
			// No reading at all is reported as degraded, never as up. A page that greens an unmeasured
			// component is the failure this whole package exists to avoid.
			health: last ? health(last, "health") : "degraded",
			reason: last ? textOrNull(last, "reason") : "no recent check",
			ms: last ? intOrNull(last, "ms") : null,
			uptime90d: uptimeFraction(days),
			history: days,
		};
	});

	const names = new Map(COMPONENTS.map((c) => [c.id, c.name]));
	const incidentSummaries: IncidentSummary[] = incidents.results.map((row) => {
		const component = text(row, "component");
		const resolvedAt = intOrNull(row, "resolved_at");
		return {
			id: int(row, "id"),
			component,
			componentName: names.get(component) ?? component,
			startedAt: new Date(int(row, "started_at") * 1000).toISOString(),
			resolvedAt: resolvedAt === null ? null : new Date(resolvedAt * 1000).toISOString(),
			worst: health(row, "worst"),
			reason: textOrNull(row, "reason"),
		};
	});

	return {
		version: SUMMARY_VERSION,
		generatedAt: new Date(Math.floor(nowMs / 1000) * 1000).toISOString(),
		state: rollUp(components),
		components,
		incidents: incidentSummaries,
	};
}

/** Write the snapshot to KV — only when it changed, or when the forced refresh is due. */
async function writeSnapshot(env: Env, nowMs: number): Promise<void> {
	const summary = await buildSummary(env, nowMs);
	const nextHash = snapshotHash(summary);
	const previous = parseSnapshot(await env.SNAPSHOT.get(SNAPSHOT_KEY));
	if (
		!shouldWriteSnapshot({
			previousHash: previous?.hash ?? null,
			nextHash,
			lastWrittenAtMs: previous?.writtenAt ?? null,
			nowMs,
		})
	) {
		return;
	}
	const stored: StoredSnapshot = {
		hash: nextHash,
		writtenAt: nowMs,
		html: renderPage(summary),
		summaryJson: JSON.stringify(summary),
	};
	await env.SNAPSHOT.put(SNAPSHOT_KEY, JSON.stringify(stored));
}

// ── serving ─────────────────────────────────────────────────────────────────

/**
 * A short `s-maxage` with `stale-while-revalidate` matters more than it looks: an incident is when
 * this page gets its traffic, and the CDN absorbing that burst keeps the page up during the event it
 * exists to describe.
 */
const CACHE = "public, max-age=15, s-maxage=30, stale-while-revalidate=120";

/** A JSON response with the API's headers. */
function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"access-control-allow-origin": "*",
			"cache-control": "no-store",
		},
	});
}

export default {
	/** The 1-minute cron: one probe cycle, kept alive until it finishes. */
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(runCycle(env, Date.now()));
	},

	/** Serve the page, the JSON API, the favicon, robots.txt and the sitemap from the one KV snapshot. */
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === "/api/summary.json") {
			const stored = parseSnapshot(await env.SNAPSHOT.get(SNAPSHOT_KEY));
			if (!stored) {
				return json({ version: SUMMARY_VERSION, state: "unknown", error: "no snapshot yet" }, 503);
			}
			return new Response(stored.summaryJson, {
				headers: {
					"content-type": "application/json; charset=utf-8",
					"cache-control": CACHE,
					// A status page has nothing to keep private — this is the one endpoint deliberately
					// readable cross-origin by anyone.
					"access-control-allow-origin": "*",
				},
			});
		}

		if (path === "/") {
			const stored = parseSnapshot(await env.SNAPSHOT.get(SNAPSHOT_KEY));
			if (!stored) {
				return new Response("Status data is not available yet.", {
					status: 503,
					headers: { "content-type": "text/plain; charset=utf-8" },
				});
			}
			return new Response(stored.html, {
				headers: {
					"content-type": "text/html; charset=utf-8",
					"cache-control": CACHE,
					"x-content-type-options": "nosniff",
					"referrer-policy": "strict-origin-when-cross-origin",
				},
			});
		}

		if (path === "/favicon.svg" || path === "/favicon.ico") {
			return new Response(FAVICON_SVG, {
				headers: {
					"content-type": "image/svg+xml; charset=utf-8",
					"cache-control": "public, max-age=86400",
				},
			});
		}

		// A status page should be indexable — most of the point of a public one.
		if (path === "/robots.txt") {
			return new Response(`User-agent: *\nAllow: /\nSitemap: ${SITE}/sitemap.xml\n`, {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		if (path === "/sitemap.xml") {
			const body =
				'<?xml version="1.0" encoding="UTF-8"?>' +
				'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
				`<url><loc>${SITE}/</loc><changefreq>always</changefreq></url>` +
				"</urlset>";
			return new Response(body, {
				headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=86400" },
			});
		}

		return new Response("Not found", { status: 404 });
	},
};
