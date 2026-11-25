// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/openapi.json/route";
import { buildOpenApiDocument, pathParameterNames } from "@/lib/openapi/document";
import { OPERATIONS } from "@/lib/openapi/operations";
import { CLI_REQUEST_ID_HEADER, isCliApiPath } from "@/lib/cli/version";

/**
 * The OpenAPI document is a valid OpenAPI 3.1 document in the ways a consumer depends on, and it
 * says what it must about authentication. Whether it still matches the routes is the drift test's
 * question (drift.test.ts); this file asks whether what it says is well-formed and honest.
 *
 * There is no OpenAPI validator in the dependency tree, so the structural rules a validator would
 * apply and a generator relies on are checked here directly: every `$ref` resolves, operation ids
 * are unique, path templates and path parameters agree, every operation has a success answer and
 * every answer a description, and every security requirement names a declared scheme.
 */

const doc = buildOpenApiDocument();

/** Every `$ref` value anywhere in `value`. */
function refsIn(value: unknown, found: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const item of value) refsIn(item, found);
	} else if (value !== null && typeof value === "object") {
		for (const [key, inner] of Object.entries(value)) {
			if (key === "$ref" && typeof inner === "string") found.push(inner);
			else refsIn(inner, found);
		}
	}
	return found;
}

/** Resolves a local `#/a/b` pointer against the document, or undefined. */
function resolvePointer(pointer: string): unknown {
	if (!pointer.startsWith("#/")) return undefined;
	let node: unknown = doc;
	for (const part of pointer.slice(2).split("/")) {
		if (node === null || typeof node !== "object") return undefined;
		node = Reflect.get(node, part);
	}
	return node;
}

/** Every operation object in the document, with its path and method. */
function operations() {
	return Object.entries(doc.paths).flatMap(([path, item]) =>
		Object.entries(item).map(([method, operation]) => ({ path, method, operation })),
	);
}

describe("the OpenAPI document is well-formed", () => {
	it("is OpenAPI 3.1 with a relative server", () => {
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.servers).toEqual([{ url: "/", description: expect.any(String) }]);
	});

	it("resolves every $ref", () => {
		const unresolved = refsIn(doc).filter((pointer) => resolvePointer(pointer) === undefined);
		expect(unresolved).toEqual([]);
	});

	it("has unique operation ids", () => {
		const ids = operations().map((each) => each.operation.operationId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("declares every path parameter its template names, and no other", () => {
		const mismatched = operations().filter(({ path, operation }) => {
			const declared = operation.parameters.filter((p) => p.in === "path");
			const names = pathParameterNames(path);
			return (
				declared.length !== names.length ||
				declared.some((p, i) => p.name !== names[i] || !p.required)
			);
		});
		expect(mismatched.map((each) => `${each.method} ${each.path}`)).toEqual([]);
	});

	it("gives every operation a success answer and every answer a description", () => {
		const offenders = operations().flatMap(({ path, method, operation }) => {
			const statuses = Object.keys(operation.responses);
			const problems: string[] = [];
			if (!statuses.some((status) => status.startsWith("2"))) problems.push(`${method} ${path}: no 2xx`);
			for (const [status, response] of Object.entries(operation.responses)) {
				if (!response.description) problems.push(`${method} ${path} ${status}: no description`);
			}
			return problems;
		});
		expect(offenders).toEqual([]);
	});

	it("names only declared security schemes and tags", () => {
		const schemes = new Set(Object.keys(doc.components.securitySchemes));
		const tags = new Set(doc.tags.map((tag) => tag.name));
		const offenders = operations().flatMap(({ path, method, operation }) => [
			...operation.security.flatMap((requirement) =>
				Object.keys(requirement).filter((name) => !schemes.has(name)).map((name) => `${method} ${path}: scheme ${name}`),
			),
			...operation.tags.filter((tag) => !tags.has(tag)).map((tag) => `${method} ${path}: tag ${tag}`),
		]);
		expect(offenders).toEqual([]);
	});

	it("carries no $schema or $id inside a component", () => {
		const offenders = Object.entries(doc.components.schemas)
			.filter(([, schema]) => "$schema" in schema || "$id" in schema)
			.map(([name]) => name);
		expect(offenders).toEqual([]);
	});

	it("documents one operation per table entry", () => {
		expect(operations()).toHaveLength(OPERATIONS.length);
	});

	it("covers the jobs, projects and other /api/cli routes", () => {
		const ids = new Set(operations().map((each) => each.operation.operationId));
		for (const id of [
			"listJobs",
			"queueJob",
			"getJob",
			"listJobLogs",
			"cancelJob",
			"createProject",
			"applyDesign",
			"whoami",
			"listMembers",
			"mintServiceToken",
			"listRunners",
			"connectCloudIdentity",
			"requestKubeconfig",
			"createAlertRule",
		]) {
			expect(ids).toContain(id);
		}
	});

	it("describes every path parameter in words of its own", () => {
		const offenders = operations().flatMap(({ path, method, operation }) =>
			operation.parameters
				.filter((p) => p.in === "path")
				.filter((p) => p.description === p.name || (p.description === "The job id." && !path.includes("/jobs/")))
				.map((p) => `${method} ${path}: ${p.name}`),
		);
		expect(offenders).toEqual([]);
	});

	it("describes only path parameters the template names", () => {
		const offenders = OPERATIONS.flatMap((operation) =>
			Object.keys(operation.pathParameters ?? {})
				.filter((name) => !pathParameterNames(operation.path).includes(name))
				.map((name) => `${operation.method} ${operation.path}: ${name}`),
		);
		expect(offenders).toEqual([]);
	});
});

describe("the OpenAPI document is honest about authentication", () => {
	it("states that a service token carries the limit it was minted with, and is refused outside it", () => {
		expect(doc.info.description).toContain("the scopes and the project list it was minted with");
		expect(doc.info.description).toContain("all five scopes over every project");
		expect(doc.info.description).toContain('error: "insufficient_scope"');
		expect(doc.info.description).not.toContain("narrow_tokens_unavailable");
	});

	it("derives each operation's scopes from the scope ceiling", () => {
		const scopes = (id: string) => operations().find((each) => each.operation.operationId === id)?.operation["x-alethia-scopes"];
		expect(scopes("listJobs")).toEqual(["read"]);
		expect(scopes("createProject")).toEqual(["design"]);
		expect(scopes("cancelJob")).toEqual(["plan"]);
		expect(scopes("queueJob")).toEqual({
			PLAN: ["plan"],
			DEPLOY: ["apply"],
			DESTROY: ["destroy"],
			DESTROY_RUNNER: ["read", "design", "plan", "apply", "destroy"],
		});
		expect(scopes("whoami")).toEqual(["read"]);
		expect(scopes("mintServiceToken")).toEqual(["read", "design", "plan", "apply", "destroy"]);
		expect(scopes("requestKubeconfig")).toEqual({ readonly: ["read"], admin: ["read", "design", "plan", "apply", "destroy"] });
	});

	it("says an operation that needs only a credential asks no permission and needs no scope", () => {
		const repositories = operations().filter((each) => each.path.startsWith("/api/cli/repositories/"));
		expect(repositories.length).toBe(3);
		for (const { operation } of repositories) {
			expect(operation["x-alethia-permission"]).toBe("none");
			expect(operation["x-alethia-scopes"]).toEqual([]);
			expect(operation.security).toEqual([{ bearerAuth: [] }]);
		}
	});

	it("puts the request id, minimum-version header and 426 on /api/cli answers only", () => {
		const offenders = operations().flatMap(({ path, method, operation }) => {
			const cli = isCliApiPath(path);
			const problems: string[] = [];
			if (cli !== "426" in operation.responses) problems.push(`${method} ${path}: 426`);
			for (const [status, response] of Object.entries(operation.responses)) {
				const hasId = response.headers !== undefined && CLI_REQUEST_ID_HEADER in response.headers;
				if (cli !== hasId) problems.push(`${method} ${path} ${status}: X-Request-Id`);
			}
			return problems;
		});
		expect(offenders).toEqual([]);
		expect(doc.info.description).toContain("cli_too_old");
		expect(doc.info.description).toContain("X-Request-Id");
	});

	it("names no host and carries no credential", () => {
		const text = JSON.stringify(doc);
		expect(text).not.toMatch(/https?:\/\//);
		expect(text).not.toMatch(/alethialabs\.io/);
		expect(text).not.toMatch(/alethia_sat_[A-Za-z0-9]/);
		expect(text).not.toMatch(/\breq_[0-9a-f]{32}\b/);
	});
});

describe("GET /api/openapi.json", () => {
	it("serves the document", async () => {
		const response = await GET();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(JSON.parse(JSON.stringify(doc)));
	});
});
