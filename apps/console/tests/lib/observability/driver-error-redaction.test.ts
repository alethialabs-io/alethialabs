// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// A database driver's error reaches neither the logs nor the error tracker with the value that failed
// (#6645). Postgres quotes the offending input in some messages (`invalid input syntax for type uuid:
// "<value>"`) and lists the conflicting key in the DETAIL of others (`Key (email)=(<value>) already
// exists.`). The driver error is the `cause` of drizzle-orm's `DrizzleQueryError`; the log serializer
// (lib/observability/log.ts) and the Sentry scrub (lib/observability/scrub.ts) both write its SQLSTATE
// `code` and its message without the value, through lib/observability/query-error.ts.
//
// The driver errors are built by postgres-js's own `PostgresError` constructor, with the fields its
// `parseError` reads off a server ErrorResponse, and wrapped in a real `DrizzleQueryError`.

import * as Sentry from "@sentry/nextjs";
import { DrizzleQueryError } from "drizzle-orm/errors";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "@/lib/observability/log";
import { failedQueryText, isDriverError, redactDriverText } from "@/lib/observability/query-error";
import { scrubEvent } from "@/lib/observability/scrub";

/** The input the uuid cast rejected; it may appear nowhere in an output. */
const BAD_UUID = "leak-uuid-7f2c'; drop";
/** The email whose insert hit the unique constraint; it may appear nowhere in an output. */
const DUP_EMAIL = "leak-dup@example.test";
/** Every value that must not reach an output. */
const VALUES = [BAD_UUID, DUP_EMAIL];

/** The ErrorResponse fields postgres-js's `parseError` produces for a rejected uuid cast. */
const UUID_FIELDS = {
	severity_local: "ERROR",
	severity: "ERROR",
	code: "22P02",
	message: `invalid input syntax for type uuid: "${BAD_UUID}"`,
	where: "unnamed portal parameter $1",
	file: "uuid.c",
	line: "133",
	routine: "string_to_uuid",
};

/** The ErrorResponse fields postgres-js's `parseError` produces for a unique violation. */
const UNIQUE_FIELDS = {
	severity_local: "ERROR",
	severity: "ERROR",
	code: "23505",
	message: 'duplicate key value violates unique constraint "users_email_key"',
	detail: `Key (email)=(${DUP_EMAIL}) already exists.`,
	schema_name: "public",
	table_name: "users",
	constraint_name: "users_email_key",
	file: "nbtinsert.c",
	line: "666",
	routine: "_bt_check_unique",
};

/**
 * Builds a `PostgresError` with postgres-js's own constructor, as its `Errors.postgres` does: the
 * constructor takes the parsed fields object (its declared type only inherits `Error`'s), then the
 * stack is captured again so its header carries the `PostgresError` name.
 */
function pgError(fields: Record<string, string>): postgres.PostgresError {
	const made: unknown = Reflect.construct(postgres.PostgresError, [fields]);
	if (!(made instanceof postgres.PostgresError)) throw new Error("not a PostgresError");
	Error.captureStackTrace(made);
	return made;
}

/** The two failed queries: a uuid lookup (22P02) and an insert that hit a unique constraint (23505). */
function failedQueries(): { uuid: DrizzleQueryError; unique: DrizzleQueryError } {
	return {
		uuid: new DrizzleQueryError('select * from "orgs" where "id" = $1', [BAD_UUID], pgError(UUID_FIELDS)),
		unique: new DrizzleQueryError(
			'insert into "users" ("email") values ($1)',
			[DUP_EMAIL],
			pgError(UNIQUE_FIELDS),
		),
	};
}

/** Asserts that no value of VALUES appears anywhere in `text`. */
function expectNoValue(text: string): void {
	for (const v of VALUES) expect(text).not.toContain(v);
	expect(text).not.toContain("params:");
}

/** Collects newline-delimited JSON log lines written to a pino destination stream. */
function collectLogger() {
	const lines: string[] = [];
	const destination = {
		write(chunk: string) {
			for (const line of chunk.split("\n")) if (line.trim()) lines.push(line);
		},
	};
	return { log: createLogger({ level: "info", destination }), lines };
}

describe("the premise", () => {
	it("postgres-js builds the driver error with the value in its message and detail", () => {
		// If the driver stopped writing them, every assertion below would pass vacuously.
		const { uuid, unique } = failedQueries();
		expect(uuid.cause).toBeInstanceOf(postgres.PostgresError);
		expect(uuid.cause).toMatchObject({ name: "PostgresError", code: "22P02" });
		expect(String(uuid.cause?.stack)).toContain(`PostgresError: invalid input syntax for type uuid: "${BAD_UUID}"`);
		expect(unique.cause).toMatchObject({ code: "23505", detail: `Key (email)=(${DUP_EMAIL}) already exists.` });
	});
});

describe("redactDriverText", () => {
	it.each([
		[`invalid input syntax for type uuid: "${BAD_UUID}"`, 'invalid input syntax for type uuid: "[REDACTED]"'],
		[`Key (email)=(${DUP_EMAIL}) already exists.`, "Key (email)=([REDACTED]) already exists."],
		[
			'duplicate key value violates unique constraint "users_email_key"',
			'duplicate key value violates unique constraint "[REDACTED]"',
		],
		// A value with a quote in it: pairing quotes one by one would leave `b` behind.
		['invalid input value for enum role: "a"b"', 'invalid input value for enum role: "[REDACTED]"'],
		// A value with a parenthesis in it, and an exclusion constraint's second key list.
		[
			"Key (r)=([1,2)) conflicts with existing key (r)=([0,5)).",
			"Key (r)=([REDACTED]).",
		],
		['Key (org_id)=(x) is not present in table "orgs".', 'Key (org_id)=([REDACTED]) is not present in table "[REDACTED]".'],
		['value "secret' , 'value "[REDACTED]"'],
		["value too long for type character varying(255)", "value too long for type character varying(255)"],
	])("rewrites %j", (input, expected) => {
		expect(redactDriverText(input)).toBe(expected);
	});
});

describe("isDriverError", () => {
	it("matches an own SQLSTATE code with a message, and nothing else", () => {
		expect(isDriverError(pgError(UUID_FIELDS))).toBe(true);
		expect(isDriverError(Object.assign(new Error("x"), { code: "23505" }))).toBe(true);
		expect(isDriverError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(false);
		expect(isDriverError(Object.assign(new Error("x"), { code: 23505 }))).toBe(false);
		expect(isDriverError(new Error('a "quoted" message'))).toBe(false);
		class Inherited extends Error {}
		Object.assign(Inherited.prototype, { code: "23505" });
		expect(isDriverError(new Inherited("x"))).toBe(false);
	});

	it("is not the failed-query test", () => {
		expect(failedQueryText(pgError(UUID_FIELDS))).toBeUndefined();
	});
});

describe("the log serializer, for a driver error under a failed query", () => {
	it.each(["uuid", "unique"] as const)("writes the code and no value for the %s error", (which) => {
		const e = failedQueries()[which];
		const { log, lines } = collectLogger();
		log.error("query failed", { err: e });
		const line = lines[0] ?? "";
		expectNoValue(line);
		const code = which === "uuid" ? "22P02" : "23505";
		const message =
			which === "uuid"
				? 'invalid input syntax for type uuid: "[REDACTED]"'
				: 'duplicate key value violates unique constraint "[REDACTED]"';
		const parsed: unknown = JSON.parse(line);
		expect(parsed).toMatchObject({
			err: { type: "DrizzleQueryError", cause: { type: "PostgresError", code, message } },
		});
		// The stack is kept, with the header rewritten rather than the frames dropped.
		expect(line).toContain(JSON.stringify(`PostgresError: ${message}`).slice(1, -1));
		expect(line).toMatch(/\\n\s+at /);
	});

	it("redacts a driver error logged directly, not under a failed query", () => {
		const { log, lines } = collectLogger();
		log.error("raw driver error", { err: pgError(UUID_FIELDS) });
		expectNoValue(lines[0] ?? "");
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ err: { code: "22P02" } });
	});

	it("leaves the quoted text of an error that is not a driver error", () => {
		const { log, lines } = collectLogger();
		log.error("other", { err: new Error('could not find "the-thing"') });
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ err: { message: 'could not find "the-thing"' } });
	});
});

describe("the Sentry scrub, for a driver error under a failed query", () => {
	/** Builds the exception entry Sentry forms from an error: its name as `type`, its message as `value`. */
	function exceptionOf(e: Error) {
		return { type: e.name, value: e.message };
	}

	it.each(["uuid", "unique"] as const)("sends the code and no value for the %s error", (which) => {
		const e = failedQueries()[which];
		const cause = e.cause instanceof Error ? e.cause : new Error("missing cause");
		const event = {
			exception: { values: [exceptionOf(cause), exceptionOf(e)] },
			breadcrumbs: [{ message: `db said ${cause.message}` }],
			extra: { code: which === "uuid" ? "22P02" : "23505", detail: "detail" in cause ? cause.detail : undefined },
		};
		const out = scrubEvent(event, { originalException: e });
		expectNoValue(JSON.stringify(out));
		expect(out.exception.values[0]?.value).toBe(redactDriverText(cause.message));
		expect(out.exception.values[0]?.value).toContain('"[REDACTED]"');
		expect(out.extra.code).toBe(which === "uuid" ? "22P02" : "23505");
	});

	it("rewrites the driver error under a failed query that is itself a cause", () => {
		const { unique } = failedQueries();
		const outer = new Error("could not save the user", { cause: unique });
		const cause = unique.cause instanceof Error ? unique.cause : new Error("missing cause");
		const out = scrubEvent(
			{ exception: { values: [exceptionOf(cause), exceptionOf(unique), exceptionOf(outer)] } },
			{ originalException: outer },
		);
		expectNoValue(JSON.stringify(out));
		expect(out.exception.values[2]?.value).toBe("could not save the user");
	});

	it("leaves the quoted text of an error whose code is not a SQLSTATE", () => {
		const e = Object.assign(new Error('job "nightly" failed'), { code: "EPIPE" });
		const out = scrubEvent({ exception: { values: [exceptionOf(e)] } }, { originalException: e });
		expect(out.exception.values[0]?.value).toBe('job "nightly" failed');
	});
});

describe("a failed query sent through the real Sentry SDK", () => {
	/** Every envelope the SDK handed to its transport, serialized. */
	const sent: string[] = [];

	beforeAll(() => {
		Sentry.init({
			dsn: "https://public@o0.ingest.sentry.io/0",
			defaultIntegrations: false,
			integrations: [Sentry.linkedErrorsIntegration()],
			skipOpenTelemetrySetup: true,
			registerEsmLoaderHooks: false,
			beforeSend: (event, hint) => scrubEvent(event, hint),
			transport: () => ({
				send: async (envelope: unknown) => {
					sent.push(JSON.stringify(envelope));
					return {};
				},
				flush: async () => true,
			}),
		});
	});

	afterAll(async () => {
		await Sentry.close();
	});

	it("sends each driver error's code-bearing exception without its value", async () => {
		const { uuid, unique } = failedQueries();
		Sentry.captureException(uuid);
		Sentry.captureException(unique);
		await Sentry.flush(2000);
		expect(sent).toHaveLength(2);
		for (const envelope of sent) {
			expectNoValue(envelope);
			expect(envelope).toContain("PostgresError");
		}
		expect(sent.join("\n")).toContain(JSON.stringify('invalid input syntax for type uuid: "[REDACTED]"'));
	});
});

describe("review follow-ups (#6661)", () => {
	it("does not take a Node system error code for a SQLSTATE", () => {
		const isDriver = (code: string) => isDriverError(Object.assign(new Error('write "x" failed'), { code }));
		expect(["EPIPE", "EPERM", "EBUSY", "ESRCH"].map(isDriver)).toEqual([false, false, false, false]);
		expect(["22P02", "23505", "P0001", "XX000"].map(isDriver)).toEqual([true, true, true, true]);
	});

	it("keeps the stack of a driver-shaped error whose message has nothing to redact", () => {
		const { log, lines } = collectLogger();
		const e = Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
		e.message = "canceling statement due to statement timeout";
		log.error("timed out", { err: e });
		const line = JSON.parse(lines[0] ?? "{}");
		expect(line.err.stack).toContain("canceling statement due to statement timeout");
	});

	it("writes the schema identifiers a redacted driver message no longer names", () => {
		const { log, lines } = collectLogger();
		log.error("insert failed", { err: failedQueries().unique });
		const text = lines.join("\n");
		expectNoValue(text);
		const cause = JSON.parse(lines[0] ?? "{}").err.cause;
		expect(cause).toMatchObject({ code: "23505", table_name: "users", constraint_name: "users_email_key", schema_name: "public" });
	});

	it("redacts a Failing row DETAIL", () => {
		expect(redactDriverText(`Failing row contains (1, ${DUP_EMAIL}, null).`)).toBe("Failing row contains ([REDACTED]).");
	});

	it("rewrites a driver error the driver raised directly, with no failed query around it", () => {
		const commit = pgError(UNIQUE_FIELDS);
		const out = scrubEvent(
			{ exception: { values: [{ type: "PostgresError", value: commit.message }] }, extra: { detail: commit.detail } },
			{ originalException: commit },
		);
		expect(JSON.stringify(out)).not.toContain(DUP_EMAIL);
		expect(out.exception.values[0]?.value).toBe('duplicate key value violates unique constraint "[REDACTED]"');
	});
});
