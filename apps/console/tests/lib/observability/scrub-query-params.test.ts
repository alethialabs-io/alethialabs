// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// A failed database query reaches the error tracker without its bound parameter values (#6633).
// drizzle-orm's `DrizzleQueryError` puts them in its `message` (`Failed query: <sql>\nparams:
// <values>`) and Sentry sends an error's message as the exception value, so the `beforeSend` scrub
// (lib/observability/scrub.ts) rewrites it to `Failed query: <sql>`, as the log serializer does
// (#6630). The first block runs the real Sentry SDK pipeline with a capturing transport; the rest
// drive the scrub directly with the event shapes Sentry builds.

import * as Sentry from "@sentry/nextjs";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubEvent } from "@/lib/observability/scrub";

/** A multi-line SQL text, as drizzle builds for a longer query. */
const SQL = 'select "id", "email"\nfrom "users"\nwhere "email" = $1 and "token" = $2';
/** The bound parameter values; none may appear anywhere in an event sent to the tracker. */
const PARAMS = ["leak-me@example.test", "zz-secret-param-9f3"];
/** The message drizzle-orm builds for SQL and PARAMS. */
const RAW_MESSAGE = `Failed query: ${SQL}\nparams: ${PARAMS.join(",")}`;

/** Builds a real drizzle-orm query error over SQL and PARAMS, caused by a driver error. */
function queryError(): DrizzleQueryError {
	const driver = Object.assign(new Error("duplicate key value violates unique constraint"), {
		code: "23505",
	});
	return new DrizzleQueryError(SQL, PARAMS, driver);
}

/** Asserts that no parameter value appears anywhere in `value`'s JSON form. */
function expectNoParams(value: unknown): void {
	const text = JSON.stringify(value);
	for (const p of PARAMS) expect(text).not.toContain(p);
	expect(text).not.toContain("params:");
}

/** Builds the exception entry Sentry forms from an error: its name as `type`, its message as `value`. */
function exceptionOf(e: Error) {
	return { type: e.name, value: e.message, stacktrace: { frames: [{ function: "f" }] } };
}

describe("a DrizzleQueryError sent through the real Sentry SDK", () => {
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
			beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
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

	it("is built by drizzle-orm with the parameter values in its message", () => {
		// The premise: if drizzle-orm stopped writing them, the tests below would pass vacuously.
		expect(queryError().message).toBe(RAW_MESSAGE);
	});

	it("sends the SQL text and the cause, and no parameter value", async () => {
		Sentry.addBreadcrumb({ category: "console", message: `query failed ${RAW_MESSAGE}` });
		Sentry.captureException(queryError());
		await Sentry.flush(2000);
		expect(sent).toHaveLength(1);
		const envelope = sent[0] ?? "";
		expectNoParams(envelope);
		expect(envelope).toContain(JSON.stringify(`Failed query: ${SQL}`));
		expect(envelope).toContain("duplicate key value violates unique constraint");
		expect(envelope).toContain(JSON.stringify(`query failed Failed query: ${SQL}`));
	});
});

describe("scrubEvent on a failed query", () => {
	it("rewrites the exception value and its cause chain from the original exception", () => {
		const error = queryError();
		const event = {
			message: RAW_MESSAGE,
			exception: { values: [exceptionOf(error.cause ?? error), exceptionOf(error)] },
		};
		const out = scrubEvent(event, { originalException: error });
		expectNoParams(out);
		expect(out.exception.values[1]?.value).toBe(`Failed query: ${SQL}`);
		expect(out.exception.values[0]?.value).toBe(
			"duplicate key value violates unique constraint",
		);
		expect(out.message).toBe(`Failed query: ${SQL}`);
	});

	it("rewrites a failed query that is the CAUSE of the thrown error", () => {
		const inner = queryError();
		const outer = new Error("could not save the user", { cause: inner });
		const event = { exception: { values: [exceptionOf(inner), exceptionOf(outer)] } };
		const out = scrubEvent(event, { originalException: outer });
		expectNoParams(out);
		expect(out.exception.values[0]?.value).toBe(`Failed query: ${SQL}`);
		expect(out.exception.values[1]?.value).toBe("could not save the user");
	});

	it("rewrites a value whose parameter text contains a stack-frame-shaped line", () => {
		// The message-shape match ends at a stack-frame line; the exact rewrite from the original
		// exception does not, so a value crafted to end the shape match early is still removed.
		const tricky = ["x\n    at evil (y)", "zz-secret-param-9f3"];
		const error = new DrizzleQueryError(SQL, tricky);
		const out = scrubEvent(
			{ exception: { values: [exceptionOf(error)] } },
			{ originalException: error },
		);
		expect(out.exception.values[0]?.value).toBe(`Failed query: ${SQL}`);
	});

	it("rewrites by message shape when there is no original exception", () => {
		const event = {
			exception: {
				values: [
					{ type: "Error", value: "duplicate key value violates unique constraint" },
					{ type: "DrizzleQueryError", value: RAW_MESSAGE },
				],
			},
		};
		const out = scrubEvent(event);
		expectNoParams(out);
		expect(out.exception.values[1]?.value).toBe(`Failed query: ${SQL}`);
	});

	it("rewrites a message Sentry truncated to its maxValueLength", () => {
		const out = scrubEvent({
			exception: { values: [{ type: "DrizzleQueryError", value: `${RAW_MESSAGE.slice(0, -4)}...` }] },
		});
		expectNoParams(out);
		expect(out.exception.values[0]?.value).toBe(`Failed query: ${SQL}`);
	});

	it("strips the parameter text from the event's breadcrumbs, keeping a following stack", () => {
		const out = scrubEvent({
			breadcrumbs: [
				{ message: `DrizzleQueryError: ${RAW_MESSAGE}\n    at handler (route.ts:1:1)` },
				{ message: "unrelated params: kept" },
			],
		});
		expectNoParams(out.breadcrumbs[0]);
		expect(out.breadcrumbs[0]?.message).toBe(
			`DrizzleQueryError: Failed query: ${SQL}\n    at handler (route.ts:1:1)`,
		);
		expect(out.breadcrumbs[1]?.message).toBe("unrelated params: kept");
	});

	it("leaves an error that is not a failed query untouched", () => {
		const error = new Error("boom");
		const out = scrubEvent(
			{ exception: { values: [exceptionOf(error)] } },
			{ originalException: error },
		);
		expect(out.exception.values[0]?.value).toBe("boom");
	});

	it("is cycle-safe on a cause chain that loops", () => {
		const a = new Error("a");
		const b = new Error("b", { cause: a });
		Object.assign(a, { cause: b });
		expect(() => scrubEvent({ message: "x" }, { originalException: a })).not.toThrow();
	});
});

describe("scrubBreadcrumb on a failed query", () => {
	it("strips the parameter text from a breadcrumb message and its data", () => {
		const out = scrubBreadcrumb({
			category: "console",
			message: `query failed ${RAW_MESSAGE}`,
			data: { arguments: [RAW_MESSAGE] },
		});
		expectNoParams(out);
		expect(out.message).toBe(`query failed Failed query: ${SQL}`);
		expect(out.data.arguments[0]).toBe(`Failed query: ${SQL}`);
	});
});
