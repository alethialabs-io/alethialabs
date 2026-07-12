// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Sentry SERVER-side error tracking for the console — the "when a request throws in prod, we see it"
// half of the observability substrate, a sibling to the OTel traces/metrics layer (otel.ts) and the
// PostHog analytics gating (lib/analytics/server.ts).
//
// STRICTLY DSN-gated, exactly like startOtel's endpoint gate: when SENTRY_DSN is unset we never even
// import @sentry/nextjs, so there is zero code, zero cost, and no dependency — a true no-op. It is
// error tracking ONLY: the console's distributed traces already flow through the OTel SDK, so Sentry
// performance tracing stays OFF (tracesSampleRate 0) and `skipOpenTelemetrySetup` stops Sentry from
// registering a competing global tracer/propagator over the one instrumentation.ts already installed —
// so the background loops + the OTel/health init are untouched.
//
// The DSN is Sentry-protocol-generic, so a self-hosted GlitchTip DSN works unchanged.

import { trace } from "@opentelemetry/api";
import type { ErrorEvent } from "@sentry/nextjs";
import { scrubBreadcrumb, scrubEvent } from "@/lib/observability/scrub";

// Double-init guard: undefined = not yet attempted, boolean = the resolved enabled state. Mirrors
// the `let client: … | undefined` singleton in lib/analytics/server.ts + the `tracerProvider` guard.
let initialized: boolean | undefined;

/** True iff SENTRY_DSN is configured — the single gate the whole layer keys off. */
export function sentryEnabled(): boolean {
	return Boolean(process.env.SENTRY_DSN);
}

/** Parses SENTRY_TRACES_SAMPLE_RATE to a [0,1] rate; defaults to 0 (error-only, OTel owns traces). */
function parseSampleRate(raw: string | undefined): number {
	if (!raw) return 0;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
}

/** Tags an outgoing event with the active OTel trace_id so an error links to its trace + logs. */
function enrichTrace(event: ErrorEvent): ErrorEvent {
	const span = trace.getActiveSpan()?.spanContext();
	if (span?.traceId) {
		// The trace_id tag is what links the error to its OTel trace + structured logs. (We don't set
		// contexts.trace — Sentry owns that when its own tracing is on; here OTel owns tracing.)
		event.tags = { ...event.tags, trace_id: span.traceId };
	}
	return event;
}

/**
 * Initializes the Sentry server SDK, but ONLY when SENTRY_DSN is set and on the Node runtime.
 * Unset ⇒ a complete no-op (@sentry/nextjs is never imported). Idempotent via the double-init guard,
 * and never throws — a bad DSN can't crash startup. Returns true iff Sentry was initialized.
 */
export async function initSentryServer(): Promise<boolean> {
	if (process.env.NEXT_RUNTIME !== "nodejs") return false;
	if (initialized !== undefined) return initialized;
	const dsn = process.env.SENTRY_DSN;
	if (!dsn) {
		initialized = false;
		return false;
	}
	try {
		const Sentry = await import("@sentry/nextjs");
		Sentry.init({
			dsn,
			environment:
				process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? "development",
			release: process.env.ALETHIA_VERSION,
			// Error tracking only — the OTel SDK (otel.ts) owns tracing.
			tracesSampleRate: parseSampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE),
			// Do NOT let Sentry install its own OTel provider/propagator over ours, and don't patch
			// the module loader — keeps the background loops + the existing OTel init untouched.
			skipOpenTelemetrySetup: true,
			registerEsmLoaderHooks: false,
			beforeSend: (event) => scrubEvent(enrichTrace(event)),
			beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
		});
		initialized = true;
		return true;
	} catch {
		// Never let a Sentry init failure crash the console — it degrades to no error tracking.
		initialized = false;
		return false;
	}
}

/**
 * Captures a server-side error to Sentry with request-context tags. Best-effort and non-blocking:
 * DSN-gated, wrapped in try/catch, and does not await a flush — so it can never block, fail, or mask
 * the request-error path it is called from (instrumentation.ts `onRequestError`). trace_id is added
 * automatically by `beforeSend` from the active OTel span. A no-op when SENTRY_DSN is unset.
 */
export async function captureServerError(
	error: unknown,
	ctx: {
		path?: string;
		method?: string;
		routeType?: string;
		routePath?: string;
		digest?: string;
	},
): Promise<void> {
	if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.SENTRY_DSN) return;
	try {
		await initSentryServer();
		const Sentry = await import("@sentry/nextjs");
		Sentry.captureException(error, {
			tags: {
				route_type: ctx.routeType,
				"http.method": ctx.method,
				"http.route": ctx.routePath,
			},
			extra: { path: ctx.path, digest: ctx.digest },
		});
	} catch {
		/* error tracking must never break the request-error path */
	}
}
