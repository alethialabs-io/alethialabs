// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Scrubbing a Sentry event or breadcrumb never changes the application objects it refers to
// (#6662). A breadcrumb from the console integration holds the logged arguments themselves, so a
// scrub that wrote through it changed a logged `DrizzleQueryError`'s own `params` (and any
// secret-named key of a logged object) for the code that still held it. The first block runs the
// real Sentry SDK with the console integration and a capturing transport; the rest drive the scrub
// directly.

import * as Sentry from "@sentry/nextjs";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubEvent } from "@/lib/observability/scrub";

/** The SQL text of the failed query. */
const SQL = 'select "id" from "users" where "email" = $1 and "token" = $2';
/** The bound parameter values; none may reach the tracker, and the error must keep them. */
const PARAMS = ["leak-me@example.test", "zz-secret-param-9f3"];
/** The message drizzle-orm builds for SQL and PARAMS. */
const RAW_MESSAGE = `Failed query: ${SQL}\nparams: ${PARAMS.join(",")}`;
/** A secret held under a secret-named key of a logged object. */
const TOKEN = "zz-logged-token-41c";

/** Builds a real drizzle-orm query error over SQL and PARAMS, caused by a driver error. */
function queryError(): DrizzleQueryError {
	return new DrizzleQueryError(SQL, [...PARAMS], new Error("duplicate key value"));
}

describe("a DrizzleQueryError logged through the real Sentry console integration", () => {
	/** Every envelope the SDK handed to its transport, serialized. */
	const sent: string[] = [];

	beforeAll(() => {
		Sentry.init({
			dsn: "https://public@o0.ingest.sentry.io/0",
			defaultIntegrations: false,
			integrations: [Sentry.consoleIntegration()],
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

	it("is built by drizzle-orm with the parameter values in its message and params", () => {
		// The premise: without them the assertions below would pass vacuously.
		const error = queryError();
		expect(error.message).toBe(RAW_MESSAGE);
		expect(error.params).toEqual(PARAMS);
	});

	it("keeps the error and the logged object as they were, and sends them scrubbed", async () => {
		const error = queryError();
		const context = { api_token: TOKEN, attempt: 1 };
		console.error("saving the user failed", error, context);
		Sentry.captureMessage("after the failed query");
		await Sentry.flush(2000);

		// The objects the application still holds are untouched.
		expect(error.params).toEqual(PARAMS);
		expect(error.message).toBe(RAW_MESSAGE);
		expect(context).toEqual({ api_token: TOKEN, attempt: 1 });

		// The envelope carries the breadcrumb, scrubbed.
		expect(sent).toHaveLength(1);
		const envelope = sent[0] ?? "";
		expect(envelope).toContain("saving the user failed");
		expect(envelope).toContain(JSON.stringify(`Failed query: ${SQL}`));
		for (const p of PARAMS) expect(envelope).not.toContain(p);
		expect(envelope).not.toContain("params:");
		expect(envelope).not.toContain(TOKEN);
		expect(envelope).toContain('"params":"[REDACTED]"');
		expect(envelope).toContain('"api_token":"[REDACTED]"');
	});
});

describe("scrubBreadcrumb copies what it changes", () => {
	it("returns scrubbed copies, leaves the originals as they were, and shares what is clean", () => {
		const clean = { region: "eu-central-1", tags: ["a", "b"] };
		const dirty = { nested: { client_secret: "s3cr3t-value", kept: "yes" } };
		const args = ["context", clean, dirty];
		const breadcrumb = { category: "console", data: { arguments: args } };

		const out = scrubBreadcrumb(breadcrumb);

		expect(out).toBe(breadcrumb);
		expect(dirty.nested.client_secret).toBe("s3cr3t-value");
		expect(args[2]).toBe(dirty);
		const sentArgs = out.data.arguments;
		expect(sentArgs).not.toBe(args);
		expect(sentArgs[2]).toEqual({ nested: { client_secret: "[REDACTED]", kept: "yes" } });
		// A clean subtree is not copied.
		expect(sentArgs[1]).toBe(clean);
	});

	it("keeps a copied error an Error, with its message and stack", () => {
		const error = queryError();
		const out = scrubBreadcrumb({ data: { arguments: [error] } });
		const copy = out.data.arguments[0];
		expect(copy).not.toBe(error);
		expect(copy).toBeInstanceOf(DrizzleQueryError);
		expect(copy?.params).toBe("[REDACTED]");
		expect(copy?.query).toBe(SQL);
		expect(copy?.message).toBe(RAW_MESSAGE);
		expect(copy?.stack).toBe(error.stack);
		expect(error.params).toEqual(PARAMS);
	});

	it("scrubs a frozen object without throwing", () => {
		const frozen = Object.freeze({ password: "hunter2-hunter2" });
		const out = scrubBreadcrumb({ data: { frozen } });
		expect(out.data.frozen).toEqual({ password: "[REDACTED]" });
		expect(frozen.password).toBe("hunter2-hunter2");
	});

	it("is cycle-safe, and a copied cycle points at the copy", () => {
		const node: { token: string; self?: unknown } = { token: "tok-value-123" };
		node.self = node;
		const out = scrubBreadcrumb({ data: { node } });
		const copy = out.data.node;
		expect(copy).not.toBe(node);
		expect(copy.token).toBe("[REDACTED]");
		expect(copy.self).toBe(copy);
		expect(node.token).toBe("tok-value-123");
		expect(node.self).toBe(node);
	});
});

describe("scrubEvent copies what it changes", () => {
	it("leaves an extra object and the thrown error as they were", () => {
		const error = queryError();
		const extra = { error, note: RAW_MESSAGE };
		const event = { extra };
		const out = scrubEvent(event, { originalException: error });
		expect(out).toBe(event);
		expect(out.extra).not.toBe(extra);
		expect(out.extra.note).toBe(`Failed query: ${SQL}`);
		expect(extra.note).toBe(RAW_MESSAGE);
		expect(extra.error).toBe(error);
		expect(error.params).toEqual(PARAMS);
	});
});

describe("accessors on a copied object (#6667 review)", () => {
	it("reads an enumerable getter once and sends the value it scrubbed", () => {
		let reads = 0;
		const logged = {
			api_token: "tok-should-not-leak",
			get note() {
				reads += 1;
				return reads === 1 ? "clean" : "pw-should-not-leak";
			},
		};
		const out = scrubBreadcrumb({ data: { arguments: [logged] } });
		expect(reads).toBe(1);
		const text = JSON.stringify(out);
		expect(text).not.toContain("pw-should-not-leak");
		expect(text).not.toContain("tok-should-not-leak");
	});

	it("does not throw when a getter throws, and leaves the original untouched", () => {
		const logged = { password: "pw-x" };
		Object.defineProperty(logged, "boom", {
			enumerable: false,
			get() {
				throw new Error("getter failed");
			},
		});
		Object.defineProperty(logged, "loud", {
			enumerable: true,
			get() {
				throw new Error("getter failed");
			},
		});
		const out = scrubBreadcrumb({ data: { arguments: [logged] } });
		expect(JSON.stringify(out)).not.toContain("pw-x");
		expect(logged.password).toBe("pw-x");
	});
});
