// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONTRACT_MODULES, contractExportName } from "@/lib/openapi/contract-schemas";
import type { OpenApiOperation, OperationPermission } from "@/lib/openapi/operation-kit";
import { OPERATIONS } from "@/lib/openapi/operations";

/**
 * The OpenAPI document follows the routes. This test READS THE ROUTE FILES — it parses each with
 * the TypeScript compiler, so what it compares is the code's structure, not its formatting — and
 * fails when the operation table (lib/openapi/operations.ts) and the code disagree:
 *
 * - a route file under a documented directory exports a method with no operation, and is not in
 *   the runner ledger below; or an operation names a route or method that does not exist;
 * - the `(action, resource)` an operation declares is not the one the handler hands `authorizeCli`
 *   (or `authorizeCliQuiet`, or the cloud-account routes' `enforceProviderPermission`), or a second
 *   check of the path's organization asks a different one; an operation declared to need only a
 *   credential asks a permission; an operation whose permission a body field chooses declares other
 *   values or actions than the code maps;
 * - the query parameters or request headers an operation declares are not the ones the handler reads;
 * - the body validator an operation declares is not the one the handler `safeParse`s, or the handler
 *   validates with a schema of its own instead of an importable one; or, for a body the route reads
 *   without a validator, the documented fields are not the ones it reads;
 * - the wire-contract schema and status of each `cliJson` answer the handler gives is not one the
 *   operation declares, or a success answer the handler builds without `cliJson` is not declared
 *   as uncontracted (or, with no body at all, as empty);
 * - an error status the handler writes is missing from the operation.
 *
 * WHAT IT CANNOT SEE, stated so nobody reads it as more: an answer built in a helper function in
 * another module (`cliEnvironmentError`, `byoWriteError`, `mintError`, the providers' `errorResponse`,
 * the guard's own 401 and 403) is not read, so those statuses are declared by hand; and a
 * validator's refinements are not compared at all — the document generates from the very schema the
 * route runs, so there is nothing to compare.
 */

/** apps/console. */
const CONSOLE = join(__dirname, "..", "..", "..");

/** The directories whose routes are the public API this document describes: every `/api/cli` route. */
const DOCUMENTED_ROOTS = ["app/api/jobs", "app/api/cli", "app/api/approvals"];

/**
 * Routes under a documented directory that are NOT public API: the runner's own channel, which a
 * runner token authenticates and no person or agent can call. Each entry is a route file and the
 * methods it exports; both directions are checked, so an entry outliving its route fails too.
 */
const RUNNER_ROUTES: Readonly<Record<string, readonly string[]>> = {
	"app/api/jobs/claim/route.ts": ["post"],
	"app/api/jobs/[id]/route.ts": ["get"],
	"app/api/jobs/[id]/addon-secrets/route.ts": ["post"],
	"app/api/jobs/[id]/git-token/route.ts": ["post"],
	"app/api/jobs/[id]/kubeconfig-mint/route.ts": ["get", "post"],
	"app/api/jobs/[id]/logs/route.ts": ["get", "post"],
	"app/api/jobs/[id]/plan-artifact/route.ts": ["get", "post"],
	"app/api/jobs/[id]/state-token/route.ts": ["post"],
	"app/api/jobs/[id]/state/route.ts": ["delete", "get", "post"],
	"app/api/jobs/[id]/state/lock/route.ts": ["delete", "post"],
	"app/api/jobs/[id]/status/route.ts": ["put"],
	"app/api/jobs/[id]/talosconfig/route.ts": ["get", "put"],
};

/**
 * Helpers in other modules that read query parameters on a handler's behalf, and the names each
 * reads. A handler calling one reads those names. The ledger is itself checked against each
 * helper's source below, so it cannot go stale either.
 */
const QUERY_HELPERS: Readonly<Record<string, { readonly module: string; readonly reads: readonly string[] }>> = {
	parsePageOpts: { module: "lib/cli/paging.ts", reads: ["cursor", "limit"] },
	resolveByoScope: { module: "lib/cli/byo-write.ts", reads: ["env"] },
	parseTarget: { module: "app/api/cli/classification/assignments/route.ts", reads: ["id", "kind"] },
};

/**
 * The calls that ask an operation's permission, each with the `(action, resource)` at arguments 1
 * and 2. `authorizeCliQuiet` is `authorizeCli` without the activity row; `enforceProviderPermission`
 * is the cloud-account routes', which authenticate through `resolveCliProvider` first.
 */
const PERMISSION_CALLS = ["authorizeCli", "authorizeCliQuiet", "enforceProviderPermission"];

/**
 * The calls that check the organization a path names, with the `(action, resource)` at arguments 3
 * and 4. Each must ask the same permission the operation declares.
 */
const ORG_CHECK_CALLS = ["ensureCliOrgAccess", "authorizeCliOrg"];

/**
 * For an operation whose permission a body field chooses through a mapping function: the function,
 * which the handler must call and whose `switch` the declared cases must equal. (`job_type` on
 * `POST /api/jobs` is checked separately: that route resolves its caller itself.)
 */
const FIELD_MAPPERS: Readonly<Record<string, { readonly module: string; readonly fn: string }>> = {
	tier: { module: "lib/kubeconfig-mint/clouds.ts", fn: "actionForTier" },
};

/** Request headers every operation accepts or that a flag declares, which the header test ignores. */
const SHARED_HEADERS = new Set(["x-alethia-org", "if-match"]);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** Every `route.ts` under `dir` (relative to apps/console), as relative paths. */
function routeFiles(dir: string): string[] {
	const abs = join(CONSOLE, dir);
	if (!existsSync(abs)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(abs)) {
		const child = join(abs, entry);
		if (statSync(child).isDirectory()) found.push(...routeFiles(join(dir, entry)));
		else if (entry === "route.ts") found.push(relative(CONSOLE, child).split(sep).join("/"));
	}
	return found;
}

/** The route file an OpenAPI path is served from: `/api/x/{id}` → `app/api/x/[id]/route.ts`. */
function routeFileOf(path: string): string {
	return `app${path.replace(/\{([^}]+)\}/g, "[$1]")}/route.ts`;
}

const parsed = new Map<string, ts.SourceFile>();

/** Parses a file under apps/console once. */
function source(file: string): ts.SourceFile {
	const cached = parsed.get(file);
	if (cached) return cached;
	const text = readFileSync(join(CONSOLE, file), "utf8");
	const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	parsed.set(file, sf);
	return sf;
}

/** True when the node carries the `export` modifier. */
function isExported(node: ts.Node): boolean {
	return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** The exported HTTP handlers of a route file, by lowercase method. */
function handlers(file: string): Map<string, ts.Node> {
	const found = new Map<string, ts.Node>();
	for (const statement of source(file).statements) {
		if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) {
			if (HTTP_METHODS.has(statement.name.text)) found.set(statement.name.text.toLowerCase(), statement);
		}
		if (ts.isVariableStatement(statement) && isExported(statement)) {
			for (const decl of statement.declarationList.declarations) {
				if (ts.isIdentifier(decl.name) && HTTP_METHODS.has(decl.name.text) && decl.initializer) {
					found.set(decl.name.text.toLowerCase(), decl.initializer);
				}
			}
		}
	}
	return found;
}

/** Every descendant of `node` (depth first). */
function descendants(node: ts.Node): ts.Node[] {
	const all: ts.Node[] = [];
	const walk = (n: ts.Node) => {
		all.push(n);
		ts.forEachChild(n, walk);
	};
	ts.forEachChild(node, walk);
	return all;
}

/** Calls inside `node` whose callee is the identifier `name`. */
function callsTo(node: ts.Node, name: string): ts.CallExpression[] {
	return descendants(node).filter(
		(n): n is ts.CallExpression => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name,
	);
}

/** A string literal's text, or undefined. */
function stringOf(node: ts.Node | undefined): string | undefined {
	return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** The value of a `prop: <literal>` property in an object literal, or undefined. */
function propertyOf(node: ts.Node | undefined, prop: string): ts.Expression | undefined {
	if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
	for (const p of node.properties) {
		if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === prop) return p.initializer;
	}
	return undefined;
}

/** The numeric value of a `status: NNN` property in an object literal, or undefined. */
function statusOf(node: ts.Node | undefined): number | undefined {
	const value = propertyOf(node, "status");
	return value && ts.isNumericLiteral(value) ? Number(value.text) : undefined;
}

/**
 * Every status number a `status` property in an object literal can take: the literal, or each
 * literal of a conditional (`status: found ? 404 : 400`). Empty when the literal has no `status`.
 */
function statusesOf(node: ts.Node | undefined): number[] {
	const value = propertyOf(node, "status");
	if (!value) return [];
	if (ts.isNumericLiteral(value)) return [Number(value.text)];
	return descendants(value).flatMap((n) => (ts.isNumericLiteral(n) ? [Number(n.text)] : []));
}

/** True when an object literal has a `status` property in any form, `{ status }` included. */
function hasStatus(node: ts.Node | undefined): boolean {
	if (!node || !ts.isObjectLiteralExpression(node)) return false;
	return node.properties.some(
		(p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === "status",
	);
}

/** The import of `name` in a file: its module specifier, or undefined when it is not imported. */
function importOf(file: string, name: string): string | undefined {
	for (const statement of source(file).statements) {
		if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
		const bindings = statement.importClause.namedBindings;
		if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((e) => e.name.text === name)) {
			return stringOf(statement.moduleSpecifier);
		}
	}
	return undefined;
}

/** The contract export name of a schema, or a marker when no contract module exports it. */
function contractExport(schema: z.ZodType | undefined): string {
	return contractExportName(schema) ?? "(not exported by a contract module)";
}

/** The module specifiers of the wire contract. */
const CONTRACT_SPECIFIERS = new Set(CONTRACT_MODULES.map((m) => m.specifier));

/** The `(action, resource)` a call asks, as `action:resource`, from the given argument positions. */
function askedBy(call: ts.CallExpression, at: number): string {
	return `${stringOf(call.arguments[at]) ?? "?"}:${stringOf(propertyOf(call.arguments[at + 1], "type")) ?? "?"}`;
}

/** `action:resource`. */
function keyOf(permission: OperationPermission): string {
	return `${permission.action}:${permission.resource}`;
}

/** The values a body field accepts, from the body's input JSON Schema. */
function fieldValues(body: z.ZodType | undefined, field: string): string[] {
	if (!body) return [];
	const property = z.toJSONSchema(body, { io: "input", unrepresentable: "any" }).properties?.[field];
	if (typeof property !== "object" || !Array.isArray(property.enum)) return [];
	return property.enum.flatMap((v) => (typeof v === "string" ? [v] : []));
}

/** `"post app/api/x/route.ts"`, for messages. */
function label(operation: OpenApiOperation): string {
	return `${operation.method} ${routeFileOf(operation.path)}`;
}

/** The handler of an operation, which the coverage test has already proven exists. */
function handlerOf(operation: OpenApiOperation): ts.Node {
	const handler = handlers(routeFileOf(operation.path)).get(operation.method);
	if (!handler) throw new Error(`no handler for ${label(operation)}`);
	return handler;
}

describe("every public route is documented, and every documented route exists", () => {
	const documented = new Set(OPERATIONS.map((o) => `${o.method} ${routeFileOf(o.path)}`));
	const existing = DOCUMENTED_ROOTS.flatMap(routeFiles).flatMap((file) =>
		[...handlers(file).keys()].map((method) => ({ file, method })),
	);

	it("documents or ledgers every exported method", () => {
		const undocumented = existing
			.filter(({ file, method }) => !documented.has(`${method} ${file}`) && !(RUNNER_ROUTES[file] ?? []).includes(method))
			.map(({ file, method }) => `${method} ${file}`);
		expect(undocumented).toEqual([]);
	});

	it("names only methods that exist", () => {
		const present = new Set(existing.map(({ file, method }) => `${method} ${file}`));
		const missing = [
			...documented,
			...Object.entries(RUNNER_ROUTES).flatMap(([file, methods]) => methods.map((m) => `${m} ${file}`)),
		].filter((key) => !present.has(key));
		expect(missing).toEqual([]);
	});

	it("never both documents and ledgers a method", () => {
		const both = Object.entries(RUNNER_ROUTES)
			.flatMap(([file, methods]) => methods.map((m) => `${m} ${file}`))
			.filter((key) => documented.has(key));
		expect(both).toEqual([]);
	});
});

describe("each documented operation matches its handler", () => {
	it("asks the permission it declares", () => {
		const offenders: string[] = [];
		for (const operation of OPERATIONS) {
			const handler = handlerOf(operation);
			const calls = PERMISSION_CALLS.flatMap((name) => callsTo(handler, name));
			const { permission } = operation;
			if ("credentialOnly" in permission) {
				if (calls.length > 0) offenders.push(`${label(operation)}: asks a permission but is declared credential-only`);
				if (callsTo(handler, "verifyCliToken").length !== 1) offenders.push(`${label(operation)}: does not verify the credential`);
				continue;
			}
			if ("perField" in permission) {
				const { field, cases } = permission.perField;
				if (field === "job_type") {
					if (calls.length > 0) offenders.push(`${label(operation)}: asks a permission but is declared per job type`);
					continue;
				}
				const resources = new Set<string>(Object.values(cases).map((c) => c.resource));
				const asked = calls.map((call) => stringOf(propertyOf(call.arguments[2], "type")));
				if (calls.length !== 1 || resources.size !== 1 || !resources.has(asked[0] ?? "?")) {
					offenders.push(`${label(operation)}: declares per ${field} on ${[...resources]}, asks on ${asked.join(", ") || "nothing"}`);
				}
				continue;
			}
			const asked = calls.map((call) => askedBy(call, 1));
			if (asked.length !== 1 || asked[0] !== keyOf(permission)) {
				offenders.push(`${label(operation)}: declares ${keyOf(permission)}, asks ${asked.join(", ") || "nothing"}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("checks the path's organization with the permission it declares", () => {
		const offenders: string[] = [];
		for (const operation of OPERATIONS) {
			const { permission } = operation;
			// POST /api/jobs resolves its own caller and checks membership itself; only an operation
			// with one declared permission has one to compare against.
			if (!("action" in permission)) continue;
			for (const call of ORG_CHECK_CALLS.flatMap((name) => callsTo(handlerOf(operation), name))) {
				const asked = askedBy(call, 3);
				if (asked !== keyOf(permission)) offenders.push(`${label(operation)}: checks the organization with ${asked}, declares ${keyOf(permission)}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("declares per job type exactly the job types the route accepts", () => {
		const queue = OPERATIONS.find((o) => "perField" in o.permission && o.permission.perField.field === "job_type");
		expect(queue).toBeDefined();
		if (!queue || !("perField" in queue.permission)) return;
		const file = routeFileOf(queue.path);
		const alias = source(file).statements.find(
			(s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === "CreatableJobType",
		);
		const accepted =
			alias && ts.isUnionTypeNode(alias.type)
				? alias.type.types.flatMap((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? [t.literal.text] : []))
				: [];
		expect([...accepted].sort()).toEqual(Object.keys(queue.permission.perField.cases).sort());
		expect(fieldValues(queue.body, "job_type").sort()).toEqual([...accepted].sort());
	});

	it("declares per body field exactly the values and actions the code maps", () => {
		const offenders: string[] = [];
		for (const operation of OPERATIONS) {
			if (!("perField" in operation.permission)) continue;
			const { field, cases } = operation.permission.perField;
			if (field === "job_type") continue;
			const mapper = FIELD_MAPPERS[field];
			if (!mapper) {
				offenders.push(`${label(operation)}: no mapper ledgered for ${field}`);
				continue;
			}
			if (callsTo(handlerOf(operation), mapper.fn).length === 0) offenders.push(`${label(operation)}: does not call ${mapper.fn}`);
			const fn = source(mapper.module).statements.find(
				(st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === mapper.fn,
			);
			const mapped: Record<string, string> = {};
			for (const clause of fn ? descendants(fn).filter(ts.isCaseClause) : []) {
				const value = stringOf(clause.expression);
				const ret = clause.statements.find(ts.isReturnStatement);
				const action = stringOf(ret?.expression);
				if (value && action) mapped[value] = action;
			}
			const declared = Object.fromEntries(Object.entries(cases).map(([value, c]) => [value, c.action]));
			if (JSON.stringify(Object.entries(mapped).sort()) !== JSON.stringify(Object.entries(declared).sort())) {
				offenders.push(`${label(operation)}: declares ${JSON.stringify(declared)}, ${mapper.fn} maps ${JSON.stringify(mapped)}`);
			}
			if (JSON.stringify(fieldValues(operation.body, field).sort()) !== JSON.stringify(Object.keys(cases).sort())) {
				offenders.push(`${label(operation)}: the body's ${field} accepts [${fieldValues(operation.body, field)}]`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("reads the query parameters it declares", () => {
		const offenders: string[] = [];
		for (const operation of OPERATIONS) {
			const handler = handlerOf(operation);
			const read = new Set<string>();
			for (const n of descendants(handler)) {
				if (
					ts.isCallExpression(n) &&
					ts.isPropertyAccessExpression(n.expression) &&
					["get", "has", "getAll"].includes(n.expression.name.text) &&
					n.expression.expression.getText().endsWith("searchParams")
				) {
					const name = stringOf(n.arguments[0]);
					if (name) read.add(name);
				}
			}
			for (const [helper, { reads }] of Object.entries(QUERY_HELPERS)) {
				if (callsTo(handler, helper).length > 0) for (const name of reads) read.add(name);
			}
			const declared = (operation.query ?? []).map((q) => q.name).sort();
			if (JSON.stringify([...read].sort()) !== JSON.stringify(declared)) {
				offenders.push(`${label(operation)}: declares [${declared}], reads [${[...read].sort()}]`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("lists in the helper ledger exactly the parameters each helper reads", () => {
		const offenders: string[] = [];
		for (const [helper, { module, reads }] of Object.entries(QUERY_HELPERS)) {
			const fn = source(module).statements.find(
				(st): st is ts.FunctionDeclaration => ts.isFunctionDeclaration(st) && st.name?.text === helper,
			);
			if (!fn) {
				offenders.push(`${helper}: not found in ${module}`);
				continue;
			}
			const actual = descendants(fn).flatMap((n) =>
				ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["get", "has"].includes(n.expression.name.text)
					? (stringOf(n.arguments[0]) ?? [])
					: [],
			);
			if (JSON.stringify([...new Set(actual)].sort()) !== JSON.stringify([...reads].sort())) {
				offenders.push(`${helper}: ledger [${reads}], reads [${[...new Set(actual)].sort()}]`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("reads the request headers it declares", () => {
		const offenders: string[] = [];
		for (const operation of OPERATIONS) {
			const read = new Set<string>();
			for (const n of descendants(handlerOf(operation))) {
				if (
					ts.isCallExpression(n) &&
					ts.isPropertyAccessExpression(n.expression) &&
					n.expression.name.text === "get" &&
					n.expression.expression.getText().endsWith("headers")
				) {
					const name = stringOf(n.arguments[0])?.toLowerCase();
					if (name && !SHARED_HEADERS.has(name)) read.add(name);
				}
			}
			const declared = (operation.headers ?? []).map((h) => h.name.toLowerCase()).sort();
			if (JSON.stringify([...read].sort()) !== JSON.stringify(declared)) {
				offenders.push(`${label(operation)}: declares [${declared}], reads [${[...read].sort()}]`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("honours If-Match exactly where it declares it", () => {
		const offenders = OPERATIONS.filter((operation) => {
			const reads = callsTo(handlerOf(operation), "parseIfMatch").length > 0;
			return reads !== (operation.ifMatch === true);
		}).map(label);
		expect(offenders).toEqual([]);
	});

	it("validates its body with the schema it declares", async () => {
		const offenders: string[] = [];
		for (const operation of OPERATIONS) {
			const file = routeFileOf(operation.path);
			const validators = descendants(handlerOf(operation)).flatMap((n) =>
				ts.isCallExpression(n) &&
				ts.isPropertyAccessExpression(n.expression) &&
				n.expression.name.text === "safeParse" &&
				ts.isIdentifier(n.expression.expression)
					? [n.expression.expression.text]
					: [],
			);
			if (operation.bodyUnvalidated) {
				if (validators.length > 0) offenders.push(`${label(operation)}: has a validator now; document that one`);
				continue;
			}
			if (validators.length === 0) {
				if (operation.body) offenders.push(`${label(operation)}: declares a body the route does not validate`);
				continue;
			}
			if (validators.length > 1) {
				offenders.push(`${label(operation)}: several validators (${validators.join(", ")})`);
				continue;
			}
			const name = validators[0];
			const spec = importOf(file, name);
			if (spec) {
				const imported: Record<string, unknown> = await import(join(CONSOLE, spec.replace(/^@\//, "")));
				if (imported[name] !== operation.body) offenders.push(`${label(operation)}: route validates with ${spec}#${name}`);
				continue;
			}
			offenders.push(
				`${label(operation)}: validates with ${name}, declared in the route file; move it to an importable module (lib/validations/cli-request-bodies.ts) and import it from both`,
			);
		}
		expect(offenders).toEqual([]);
	});

	it("documents an unvalidated body's fields as the fields the handler reads", () => {
		const unvalidated = OPERATIONS.filter((o) => o.bodyUnvalidated);
		expect(unvalidated.length).toBeGreaterThan(0);
		const offenders: string[] = [];
		for (const operation of unvalidated) {
			const read = new Set<string>();
			for (const n of descendants(handlerOf(operation))) {
				// const { a, b } = body;
				if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer?.getText() === "body") {
					for (const element of n.name.elements) if (ts.isIdentifier(element.name)) read.add(element.name.text);
				}
				// body?.a / body.a
				if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "body") {
					read.add(n.name.text);
				}
			}
			const documented = operation.body instanceof z.ZodObject ? Object.keys(operation.body.shape) : [];
			if (JSON.stringify([...read].sort()) !== JSON.stringify(documented.sort())) {
				offenders.push(`${label(operation)}: documents [${documented.sort()}], reads [${[...read].sort()}]`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("answers with the contract schemas and statuses it declares", () => {
		const offenders: string[] = [];
		for (const operation of OPERATIONS) {
			const file = routeFileOf(operation.path);
			const handler = handlerOf(operation);
			const answered = new Set<string>();
			for (const call of callsTo(handler, "cliJson")) {
				const arg = call.arguments[0];
				const fromContract = arg && ts.isIdentifier(arg) && CONTRACT_SPECIFIERS.has(importOf(file, arg.text) ?? "");
				const name = fromContract ? arg.text : `(not from a contract module: ${arg?.getText() ?? "?"})`;
				answered.add(`${statusOf(call.arguments[2]) ?? 200} ${name}`);
			}
			for (const n of descendants(handler)) {
				if (
					ts.isCallExpression(n) &&
					ts.isPropertyAccessExpression(n.expression) &&
					n.expression.expression.getText() === "NextResponse" &&
					n.expression.name.text === "json"
				) {
					// No `status` at all is a 200. A computed one is read by the error-status test below.
					if (!hasStatus(n.arguments[1])) answered.add("200 uncontracted");
					const status = statusOf(n.arguments[1]);
					if (status !== undefined && status < 400) answered.add(`${status} uncontracted`);
				}
				// new NextResponse(null, { status: 304 }) — an answer with no body.
				if (ts.isNewExpression(n) && n.expression.getText() === "NextResponse") {
					const status = statusOf(n.arguments?.[1]);
					if (status !== undefined && status < 400) answered.add(`${status} empty`);
				}
			}
			const declared = new Set(
				operation.responses
					.filter((r) => r.schema || r.uncontracted || r.empty)
					.map((r) => `${r.status} ${r.schema ? contractExport(r.schema) : r.empty ? "empty" : "uncontracted"}`),
			);
			const left = [...answered].filter((a) => !declared.has(a));
			const right = [...declared].filter((d) => !answered.has(d));
			if (left.length || right.length) {
				offenders.push(`${label(operation)}: answers [${[...answered].sort()}], declares [${[...declared].sort()}]`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("declares every error status the handler writes", () => {
		const offenders: string[] = [];
		for (const operation of OPERATIONS) {
			const written = new Set<number>();
			for (const n of descendants(handlerOf(operation))) {
				if (ts.isObjectLiteralExpression(n)) {
					for (const status of statusesOf(n)) if (status >= 400) written.add(status);
				}
			}
			const declared = new Set(operation.responses.map((r) => r.status));
			const missing = [...written].filter((s) => !declared.has(s)).sort();
			if (missing.length) offenders.push(`${label(operation)}: writes ${missing.join(", ")} undeclared`);
		}
		expect(offenders).toEqual([]);
	});
});
