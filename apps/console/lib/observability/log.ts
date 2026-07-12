// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import pino from "pino";

// Map pino level → OTel severity. Used by the log bridge below.
const OTEL_SEVERITY: Record<string, SeverityNumber> = {
	debug: SeverityNumber.DEBUG,
	info: SeverityNumber.INFO,
	warn: SeverityNumber.WARN,
	error: SeverityNumber.ERROR,
};

/**
 * Mirror one structured line into the OTel logs pipeline (shipped to PostHog / a collector by
 * lib/observability/otel.ts). `logs.getLogger()` is the API no-op until a LoggerProvider is
 * registered (only when an OTLP logs endpoint is configured), so this is free + silent otherwise, and
 * never throws into the caller. The correlation fields (trace_id/org_id/job_id) ride as attributes so a
 * log joins its trace. Errors are flattened to string attributes (OTel attrs are primitives).
 */
function bridgeToOtel(level: string, msg: string, fields?: LogFields): void {
	try {
		const attributes: Record<string, string | number | boolean> = {};
		for (const [k, v] of Object.entries(fields ?? {})) {
			if (v == null) continue;
			if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
				attributes[k] = v;
			} else if (k === "err" && v instanceof Error) {
				attributes["error.message"] = v.message;
				if (v.stack) attributes["error.stack"] = v.stack;
			} else {
				attributes[k] = JSON.stringify(v);
			}
		}
		logs.getLogger("alethia-console").emit({
			severityNumber: OTEL_SEVERITY[level] ?? SeverityNumber.INFO,
			severityText: level,
			body: msg,
			attributes,
		});
	} catch {
		/* the log bridge must never break a log call */
	}
}

/**
 * Structured-log fields carried on every line. The four correlation keys
 * (trace_id / job_id / org_id / runner_id) let a console log join the runner
 * spans + logs for the same W3C trace. Extra keys are allowed (open record).
 */
export interface LogFields {
	/** W3C trace-id (the 32-hex middle segment of a `traceparent`). */
	trace_id?: string;
	job_id?: string;
	org_id?: string;
	runner_id?: string;
	/** A caught error — serialized as `{ type, message, stack }` by pino. */
	err?: unknown;
	[key: string]: unknown;
}

/**
 * A thin structured logger over pino. Argument order is `(msg, fields)` so a call
 * reads message-first; a `child(bindings)` returns a logger that stamps `bindings`
 * on every subsequent line (the correlation-id carrier).
 */
export interface Logger {
	/** Log at info level. */
	info(msg: string, fields?: LogFields): void;
	/** Log at warn level. */
	warn(msg: string, fields?: LogFields): void;
	/** Log at error level. */
	error(msg: string, fields?: LogFields): void;
	/** Log at debug level. */
	debug(msg: string, fields?: LogFields): void;
	/** Derive a child logger that carries `bindings` on every line. */
	child(bindings: LogFields): Logger;
}

/** Wraps a pino instance so callers get the message-first `(msg, fields)` shape. Every line is also
 * mirrored to the OTel logs pipeline (no-op until an OTLP logs endpoint is configured). */
function wrap(p: pino.Logger): Logger {
	return {
		info: (msg, fields) => {
			p.info(fields ?? {}, msg);
			bridgeToOtel("info", msg, fields);
		},
		warn: (msg, fields) => {
			p.warn(fields ?? {}, msg);
			bridgeToOtel("warn", msg, fields);
		},
		error: (msg, fields) => {
			p.error(fields ?? {}, msg);
			bridgeToOtel("error", msg, fields);
		},
		debug: (msg, fields) => {
			p.debug(fields ?? {}, msg);
			bridgeToOtel("debug", msg, fields);
		},
		child: (bindings) => wrap(p.child(bindings)),
	};
}

/**
 * Builds a structured JSON logger. Level comes from `opts.level` or the runtime
 * env `ALETHIA_LOG_LEVEL` (default `info`); an optional `destination` stream is
 * used by tests to capture output (production writes to stdout). No DB enum backs
 * the level — the deliberately-dropped `logs_level` type is never reintroduced.
 */
/** pino's built-in levels (+ `silent`). An out-of-set default level throws at construction. */
const PINO_LEVELS = new Set([
	"trace",
	"debug",
	"info",
	"warn",
	"error",
	"fatal",
	"silent",
]);

export function createLogger(opts?: {
	level?: string;
	destination?: pino.DestinationStream;
}): Logger {
	// `??` does NOT fall back on an empty string, and the prod deploy emits ALETHIA_LOG_LEVEL even when
	// unset → "". An empty/blank/unknown level makes pino throw at construction ("default level: must be
	// included in custom levels"); since this runs at module load (instrumentation.ts), that crash 500s
	// the whole server. So normalize: blank or unrecognized → "info".
	const requested = (opts?.level ?? process.env.ALETHIA_LOG_LEVEL ?? "").trim();
	const level = PINO_LEVELS.has(requested) ? requested : "info";
	const options: pino.LoggerOptions = {
		level,
		// Drop pid/hostname noise; correlation fields carry the useful context.
		base: undefined,
		timestamp: pino.stdTimeFunctions.isoTime,
		formatters: {
			// Emit the textual level ("info") rather than the numeric code.
			level: (label) => ({ level: label }),
		},
		serializers: { err: pino.stdSerializers.err },
	};
	return wrap(
		opts?.destination ? pino(options, opts.destination) : pino(options),
	);
}

/** The process-wide base logger. Attach correlation ids with `log.child({...})`. */
export const log = createLogger();
