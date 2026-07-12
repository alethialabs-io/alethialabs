// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import pino from "pino";

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

/** Wraps a pino instance so callers get the message-first `(msg, fields)` shape. */
function wrap(p: pino.Logger): Logger {
	return {
		info: (msg, fields) => p.info(fields ?? {}, msg),
		warn: (msg, fields) => p.warn(fields ?? {}, msg),
		error: (msg, fields) => p.error(fields ?? {}, msg),
		debug: (msg, fields) => p.debug(fields ?? {}, msg),
		child: (bindings) => wrap(p.child(bindings)),
	};
}

/**
 * Builds a structured JSON logger. Level comes from `opts.level` or the runtime
 * env `ALETHIA_LOG_LEVEL` (default `info`); an optional `destination` stream is
 * used by tests to capture output (production writes to stdout). No DB enum backs
 * the level — the deliberately-dropped `logs_level` type is never reintroduced.
 */
export function createLogger(opts?: {
	level?: string;
	destination?: pino.DestinationStream;
}): Logger {
	const level = opts?.level ?? process.env.ALETHIA_LOG_LEVEL ?? "info";
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
