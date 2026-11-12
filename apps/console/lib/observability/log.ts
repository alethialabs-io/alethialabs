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

/** How deep `serializeErr` follows `cause` / `errors` before it stops. */
const MAX_ERR_DEPTH = 5;
/** How many entries of an `errors` array `serializeErr` writes. */
const MAX_ERR_CHILDREN = 10;

/** A serialized error: the documented fields only. */
interface SerializedErr {
	type: string;
	message?: string;
	stack?: string;
	code?: string | number | boolean;
	status?: string | number | boolean;
	statusCode?: string | number | boolean;
	cause?: SerializedErrValue;
	errors?: SerializedErrValue[];
	aggregateErrors?: SerializedErrValue[];
}

/** What `serializeErr` returns: a serialized error, or a string for a primitive / marker. */
type SerializedErrValue = SerializedErr | string;

/** Returns `value` when it is a string, number or boolean, else `undefined`. */
function primitiveOrUndefined(value: unknown): string | number | boolean | undefined {
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	return undefined;
}

/**
 * Serializes an `errors` array entry by entry, bounded by MAX_ERR_CHILDREN. A longer array ends in
 * a `"[+N more]"` marker, so a reader can tell entries were left out.
 */
function serializeErrList(
	list: readonly unknown[],
	depth: number,
	ancestors: Set<object>,
): SerializedErrValue[] {
	const out = list.slice(0, MAX_ERR_CHILDREN).map((e) => serializeErrAt(e, depth, ancestors));
	if (list.length > MAX_ERR_CHILDREN) out.push(`[+${list.length - MAX_ERR_CHILDREN} more]`);
	return out;
}

/** Copies `code`, `status` and `statusCode` from `value` onto `out` when each is a primitive. */
function copyStatusFields(value: object, out: SerializedErr): void {
	const code = "code" in value ? primitiveOrUndefined(value.code) : undefined;
	if (code !== undefined) out.code = code;
	const status = "status" in value ? primitiveOrUndefined(value.status) : undefined;
	if (status !== undefined) out.status = status;
	const statusCode = "statusCode" in value ? primitiveOrUndefined(value.statusCode) : undefined;
	if (statusCode !== undefined) out.statusCode = statusCode;
}

/** The recursive step of `serializeErr`; `ancestors` holds the objects on the current path. */
function serializeErrAt(
	value: unknown,
	depth: number,
	ancestors: Set<object>,
): SerializedErrValue {
	if (value === null || (typeof value !== "object" && typeof value !== "function")) {
		return String(value);
	}
	if (ancestors.has(value)) return "[Circular]";
	if (depth >= MAX_ERR_DEPTH) return "[MaxDepth]";
	// Error-like, as pino's own serializer defines it: an object with a string `message`. Anything
	// else keeps only its constructor's name and the primitive status fields — never its other fields.
	if (!("message" in value) || typeof value.message !== "string") {
		const other: SerializedErr = { type: value.constructor?.name || typeof value };
		copyStatusFields(value, other);
		return other;
	}
	const out: SerializedErr = {
		type: value.constructor?.name || "Error",
		message: value.message,
	};
	if ("stack" in value && typeof value.stack === "string") out.stack = value.stack;
	copyStatusFields(value, out);

	ancestors.add(value);
	try {
		if ("cause" in value && value.cause !== undefined) {
			out.cause = serializeErrAt(value.cause, depth + 1, ancestors);
		}
		if ("errors" in value && Array.isArray(value.errors)) {
			const list = serializeErrList(value.errors, depth + 1, ancestors);
			if (value instanceof AggregateError) out.aggregateErrors = list;
			else out.errors = list;
		}
	} finally {
		ancestors.delete(value);
	}
	return out;
}

/**
 * The logger's `err` serializer. Emits only `type`, `message` and `stack`, plus `code`, `status`
 * and `statusCode` when they are primitives, recursing into `cause` and `errors` under the same
 * rule (at most MAX_ERR_DEPTH levels, the deepest replaced by `"[MaxDepth]"`, and MAX_ERR_CHILDREN
 * entries; a cycle becomes `"[Circular]"`). Unlike `pino.stdSerializers.err`, no other enumerable
 * property of the error is copied, and a cause is nested under `cause` rather than folded into the
 * top-level `message` / `stack`. A primitive is written as `String(value)`; a non-error object as
 * `{ type }` (its constructor's name) plus any primitive `code` / `status` / `statusCode`.
 */
function serializeErr(value: unknown): SerializedErrValue {
	return serializeErrAt(value, 0, new Set());
}

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
			if (k === "err") {
				// The same allow-list as the pino line: never JSON-dump an arbitrary error object.
				const e = serializeErr(v);
				if (typeof e === "string") {
					attributes["error.message"] = e;
				} else {
					attributes["error.type"] = e.type;
					if (e.message !== undefined) attributes["error.message"] = e.message;
					if (e.stack) attributes["error.stack"] = e.stack;
					if (e.code !== undefined) attributes["error.code"] = e.code;
				}
			} else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
				attributes[k] = v;
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
	/**
	 * A caught error. Serialized by `serializeErr`, which emits only `type`, `message` and `stack`,
	 * plus `code` / `status` / `statusCode` when they are primitives, and recurses into `cause` and
	 * `errors` (`aggregateErrors` for an `AggregateError`) under the same rule. Any other property
	 * of the error is not written. A non-error value is written as `String(value)` if it is a
	 * primitive, else as `{ type }`.
	 */
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
		serializers: { err: serializeErr },
	};
	return wrap(
		opts?.destination ? pino(options, opts.destination) : pino(options),
	);
}

/** The process-wide base logger. Attach correlation ids with `log.child({...})`. */
export const log = createLogger();
