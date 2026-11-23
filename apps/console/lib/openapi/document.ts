// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import { requiredScopes } from "@/lib/authz/scope-ceiling";
import {
	CLI_MIN_VERSION_HEADER,
	CLI_REQUEST_ID_HEADER,
	CLI_TOO_OLD_CODE,
	CLI_VERSION_HEADER,
	isCliApiPath,
} from "@/lib/cli/version";
import { SERVICE_TOKEN_PREFIX } from "@/lib/cli/service-token";
import { contractExportName } from "@/lib/openapi/contract-schemas";
import {
	type OpenApiOperation,
	OPERATION_TAGS,
	type OperationPermission,
	type OperationResponse,
	PROJECT_ID_DESCRIPTION,
} from "@/lib/openapi/operation-kit";
import { OPERATIONS } from "@/lib/openapi/operations";

/**
 * Builds the public OpenAPI 3.1 document (agent surface, unit L12) served at `/api/openapi.json`.
 *
 * Every schema in it is generated with `z.toJSONSchema` from the schema the route itself uses —
 * the wire contract `cliJson` checks each answer against, and the validator each body goes through
 * (`operations.ts` says which). Component names are the wire contract's own export names, so a
 * reader can find the schema behind any component by name.
 *
 * Nothing in the document names a host: `servers` is the relative `/`, so it describes whichever
 * control plane served it, hosted or self-hosted. No example carries a credential.
 */

/** A JSON Schema as `z.toJSONSchema` produces it. */
type JsonSchema = z.core.JSONSchema.BaseSchema;

/** An OpenAPI parameter object. */
interface ParameterObject {
	name: string;
	in: "path" | "query" | "header";
	required: boolean;
	description: string;
	schema: JsonSchema;
}

/** An OpenAPI header object. */
interface HeaderObject {
	description: string;
	schema: JsonSchema;
}

/** A reference to a header in `components.headers`. */
interface HeaderRef {
	$ref: string;
}

/** An OpenAPI response object. */
interface ResponseObject {
	description: string;
	headers?: Record<string, HeaderRef>;
	content?: { "application/json": { schema: JsonSchema } };
}

/** An OpenAPI operation object, with the two extensions this document adds. */
interface OperationObject {
	operationId: string;
	tags: string[];
	summary: string;
	description?: string;
	security: Array<{ bearerAuth: string[] }>;
	parameters: ParameterObject[];
	requestBody?: { required: true; content: { "application/json": { schema: JsonSchema } } };
	responses: Record<string, ResponseObject>;
	/**
	 * The permission the route asks the policy decision point, `resource:action`; per value of the
	 * deciding body field where the body chooses it; `none` where only a valid credential is needed.
	 */
	"x-alethia-permission": string | Record<string, string>;
	/** The token scopes the operation needs; per value of the deciding body field where it chooses. */
	"x-alethia-scopes": string[] | Record<string, string[]>;
}

/** The OpenAPI document. */
export interface OpenApiDocument {
	openapi: "3.1.0";
	info: { title: string; version: string; description: string };
	servers: Array<{ url: string; description: string }>;
	security: Array<{ bearerAuth: string[] }>;
	tags: Array<{ name: string; description: string }>;
	paths: Record<string, Record<string, OperationObject>>;
	components: {
		securitySchemes: Record<string, { type: "http"; scheme: "bearer"; description: string }>;
		schemas: Record<string, JsonSchema>;
		headers: Record<string, HeaderObject>;
	};
}

/** The version of this document's contract. Raised when an operation is removed or narrowed. */
export const OPENAPI_DOCUMENT_VERSION = "0.1.0";

/**
 * The error body every route answers a refusal or failure with. Not part of the wire contract
 * (routes write it with `NextResponse.json`), so it is stated here, loosely: `error` is always
 * present, the rest only on the answers that set them, and a route may add fields (`tenants`,
 * `reason`) that its operation's description names.
 */
export const errorBody = z.looseObject({
	error: z.string().describe("A sentence for a person."),
	code: z.string().optional().describe("A stable machine-readable reason, on the refusals that have one."),
	hint: z.string().optional().describe("What to do next, on the refusals that have one."),
	request_id: z.string().optional().describe("The request's id, on refusals under /api/cli."),
});

/** The component name of the error body. */
const ERROR_COMPONENT = "Error";

/** A `$ref` to a component schema. */
function ref(name: string): JsonSchema {
	return { $ref: `#/components/schemas/${name}` };
}

/**
 * The component name of a wire-contract schema: its export name in its contract module
 * (lib/openapi/contract-schemas.ts) with the `cli` prefix and `Wire` suffix dropped
 * (`cliJobResponse` → `JobResponse`, `jobWire` → `Job`). Throws for a schema no contract module
 * exports, because the document must never carry a response shape the contract does not define.
 */
export function contractComponentName(schema: z.ZodType): string {
	const exportName = contractExportName(schema);
	if (exportName === undefined) {
		throw new Error("a documented response schema is not exported by a wire-contract module");
	}
	const bare = exportName.replace(/^cli(?=[A-Z])/, "").replace(/Wire$/, "");
	return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** The component name of an operation's request body: `queueJob` → `QueueJobRequest`. */
export function requestComponentName(operation: OpenApiOperation): string {
	return `${operation.operationId.charAt(0).toUpperCase()}${operation.operationId.slice(1)}Request`;
}

/** Drops the per-schema `$schema` and `$id` keys `z.toJSONSchema` writes on registry members. */
function bareSchema(schema: JsonSchema): JsonSchema {
	const bare: JsonSchema = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key !== "$schema" && key !== "$id") bare[key] = value;
	}
	return bare;
}

/**
 * Generates the component schemas: every response schema in output form (what the server sends)
 * and every request body in input form (what a client may send — a field with a default is
 * optional). Each set goes through one registry so a schema used twice is one component and the
 * others `$ref` it.
 */
function componentSchemas(operations: readonly OpenApiOperation[]): Record<string, JsonSchema> {
	const responses = z.registry<{ id: string }>();
	const requests = z.registry<{ id: string }>();
	for (const operation of operations) {
		for (const response of operation.responses) {
			if (response.schema && !responses.has(response.schema)) {
				responses.add(response.schema, { id: contractComponentName(response.schema) });
			}
		}
		if (operation.body) requests.add(operation.body, { id: requestComponentName(operation) });
	}
	const options = {
		target: "draft-2020-12",
		unrepresentable: "any",
		uri: (id: string) => `#/components/schemas/${id}`,
	} as const;
	const output = z.toJSONSchema(responses, { ...options, io: "output" }).schemas;
	const input = z.toJSONSchema(requests, { ...options, io: "input" }).schemas;
	const schemas: Record<string, JsonSchema> = {};
	for (const [name, schema] of Object.entries({ ...output, ...input })) schemas[name] = bareSchema(schema);
	schemas[ERROR_COMPONENT] = bareSchema(z.toJSONSchema(errorBody, { target: "draft-2020-12" }));
	return schemas;
}

/** `resource:action`, the PDP's own spelling of a permission. */
function permissionKey(permission: OperationPermission): string {
	return `${permission.resource}:${permission.action}`;
}

/**
 * The scopes an operation needs and its permission, for the document: one pair; one per value of
 * the body field that chooses the permission (`job_type`, `tier`); or none at all for an operation
 * that needs only a valid credential.
 */
function authorization(operation: OpenApiOperation): Pick<
	OperationObject,
	"security" | "x-alethia-permission" | "x-alethia-scopes"
> {
	const { permission } = operation;
	if ("credentialOnly" in permission) {
		return { security: [{ bearerAuth: [] }], "x-alethia-permission": "none", "x-alethia-scopes": [] };
	}
	if ("perField" in permission) {
		const scopes: Record<string, string[]> = {};
		const permissions: Record<string, string> = {};
		for (const [value, each] of Object.entries(permission.perField.cases)) {
			scopes[value] = [...requiredScopes(each.action, each.resource)];
			permissions[value] = permissionKey(each);
		}
		return { security: [{ bearerAuth: [] }], "x-alethia-permission": permissions, "x-alethia-scopes": scopes };
	}
	const scopes = [...requiredScopes(permission.action, permission.resource)];
	return {
		security: [{ bearerAuth: scopes }],
		"x-alethia-permission": permissionKey(permission),
		"x-alethia-scopes": scopes,
	};
}

/** The path parameters of a template, in order: `/a/{id}/b/{kind}` → `["id", "kind"]`. */
export function pathParameterNames(path: string): string[] {
	return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

/** What each path parameter means: the operation's own word for it, else the shared defaults. */
function pathParameterDescription(operation: OpenApiOperation, name: string): string {
	const own = operation.pathParameters?.[name];
	if (own !== undefined) return own;
	const { path } = operation;
	if (name === "id" && path.startsWith("/api/cli/projects/")) return PROJECT_ID_DESCRIPTION;
	if (name === "id") return "The job id.";
	if (name === "kind") return "The component kind, e.g. `network`, `cluster` or `databases`.";
	if (name === "name") return "The component's name within its kind.";
	if (name === "promotionId") return "The promotion id.";
	return name;
}

/** The header parameters every operation accepts, plus the CLI-only ones under /api/cli. */
function headerParameters(operation: OpenApiOperation): ParameterObject[] {
	const headers: ParameterObject[] = [
		{
			name: "X-Alethia-Org",
			in: "header",
			required: false,
			description:
				"The organization to act in, by id, for a device-login token. A service token is pinned to the organization it was minted in, and a different value here is refused.",
			schema: { type: "string" },
		},
	];
	if (isCliApiPath(operation.path)) {
		headers.push({
			name: CLI_VERSION_HEADER,
			in: "header",
			required: false,
			description:
				"The client's version. A request naming a version below the configured minimum is refused with 426; one naming none is never refused for it.",
			schema: { type: "string" },
		});
	}
	for (const header of operation.headers ?? []) {
		headers.push({
			name: header.name,
			in: "header",
			required: header.required === true,
			description: header.description,
			schema: { type: "string" },
		});
	}
	if (operation.ifMatch) {
		headers.push({
			name: "If-Match",
			in: "header",
			required: false,
			description:
				"The component's `updated_at` as last read. The write is refused with 409 `component_changed` when the component has changed since.",
			schema: { type: "string" },
		});
	}
	return headers;
}

/** The response headers an /api/cli answer carries. */
function cliResponseHeaders(): Record<string, HeaderRef> {
	return {
		[CLI_REQUEST_ID_HEADER]: { $ref: "#/components/headers/RequestId" },
		[CLI_MIN_VERSION_HEADER]: { $ref: "#/components/headers/MinCliVersion" },
	};
}

/** Builds one response object. */
function responseObject(operation: OpenApiOperation, response: OperationResponse): ResponseObject {
	const object: ResponseObject = { description: response.description };
	if (isCliApiPath(operation.path)) object.headers = cliResponseHeaders();
	if (response.schema) {
		object.content = { "application/json": { schema: ref(contractComponentName(response.schema)) } };
	} else if (!response.uncontracted && !response.empty) {
		object.content = { "application/json": { schema: ref(ERROR_COMPONENT) } };
	}
	return object;
}

/** The answers every operation can give besides its own: no credential, and a scope refusal. */
const COMMON_RESPONSES: readonly OperationResponse[] = [
	{ status: 401, description: "No credential, or one that is invalid, revoked or expired." },
	{
		status: 403,
		description:
			"Refused by the permission check, or — `error: \"insufficient_scope\"` with a `reason` — by the credential's scopes or project list.",
	},
];

/** The 426 an /api/cli request below the configured minimum CLI version gets. */
const CLI_TOO_OLD_RESPONSE: OperationResponse = {
	status: 426,
	description: `The \`${CLI_VERSION_HEADER}\` the request named is below the minimum this server accepts, which \`${CLI_MIN_VERSION_HEADER}\` names. \`code\` is \`${CLI_TOO_OLD_CODE}\` and \`hint\` says how to update. Sent before the route runs.`,
};

/** Builds one operation object. */
function operationObject(operation: OpenApiOperation): OperationObject {
	const parameters: ParameterObject[] = [
		...pathParameterNames(operation.path).map(
			(name): ParameterObject => ({
				name,
				in: "path",
				required: true,
				description: pathParameterDescription(operation, name),
				schema: { type: "string" },
			}),
		),
		...(operation.query ?? []).map(
			(query): ParameterObject => ({
				name: query.name,
				in: "query",
				required: false,
				description: query.description,
				schema: bareSchema(z.toJSONSchema(query.schema, { target: "draft-2020-12", io: "input" })),
			}),
		),
		...headerParameters(operation),
	];

	const answers = new Map<number, OperationResponse>();
	for (const response of operation.responses) answers.set(response.status, response);
	for (const common of COMMON_RESPONSES) {
		const own = answers.get(common.status);
		answers.set(common.status, own ? { ...own, description: `${own.description} ${common.description}` } : common);
	}
	if (isCliApiPath(operation.path)) answers.set(CLI_TOO_OLD_RESPONSE.status, CLI_TOO_OLD_RESPONSE);

	const responses: Record<string, ResponseObject> = {};
	for (const status of [...answers.keys()].sort((a, b) => a - b)) {
		const response = answers.get(status);
		if (response) responses[String(status)] = responseObject(operation, response);
	}

	const object: OperationObject = {
		operationId: operation.operationId,
		tags: [operation.tag],
		summary: operation.summary,
		...authorization(operation),
		parameters,
		responses,
	};
	if (operation.description) object.description = operation.description;
	if (operation.body) {
		object.requestBody = {
			required: true,
			content: { "application/json": { schema: ref(requestComponentName(operation)) } },
		};
	}
	return object;
}

/** The document's introduction: authentication, scopes, request ids and the version handshake. */
const DESCRIPTION = [
	"The Alethia control plane's public HTTP API: the routes the `alethia` CLI and outside agents use to create and design projects, to plan, deploy and destroy them, and to administer the organization around them. Every response schema here is generated from the wire contract the server checks each answer against before sending it; an answer outside that contract says so in its description.",
	"",
	"## Authentication",
	"",
	"Send `Authorization: Bearer <token>`. Two credentials are accepted:",
	"",
	"- the token `alethia login` stores — a device login, acting as the person who signed in; it picks its organization with `X-Alethia-Org`;",
	`- a service token (prefix \`${SERVICE_TOKEN_PREFIX}\`), minted by an organization admin. It acts as the person who minted it and is pinned to the organization it was minted in; an \`X-Alethia-Org\` naming another organization is refused.`,
	"",
	"Either way the caller's own role decides what it may do: a token never exceeds the person behind it.",
	"",
	"## Scopes",
	"",
	"Five scopes name the agent lifecycle on a project: `read`, `design`, `plan`, `apply` and `destroy`. Each operation lists the scopes it needs in its security requirement and in `x-alethia-scopes`, and the permission it asks in `x-alethia-permission`; administration of the organization (members, tokens, connectors, runners, alerts and the like) needs all five. Where a body field chooses the permission (`job_type` when queueing a job, `tier` when minting a kubeconfig), both are listed per value. The repository listings, which read nothing of the organization's, need a valid credential and no scope.",
	"",
	"A service token carries the scopes and the project list it was minted with; minted with neither, it carries all five scopes over every project of its organization. A request outside them is refused with 403 and `error: \"insufficient_scope\"`.",
	"",
	"## Request ids and the CLI version handshake",
	"",
	`Every response under \`/api/cli\` carries \`X-Request-Id\` (\`req_\` and 32 hex digits). The server mints it and ignores any value the request sent; quote it when reporting a problem. Responses outside \`/api/cli\` (\`/api/jobs\`) do not carry one.`,
	"",
	`A client may name its version in \`X-Alethia-CLI-Version\`. When the operator has configured a minimum, every \`/api/cli\` response names it in \`X-Alethia-Min-CLI\`, and a request naming a lower version is refused with 426 and \`code: "${CLI_TOO_OLD_CODE}"\` before the route runs. A request that names no version, or one that does not parse, is never refused for it.`,
	"",
	"## Errors",
	"",
	"A refusal or failure answers with the `Error` body: `error` is a sentence for a person, and `code`, where present, is the stable reason to branch on.",
].join("\n");

/** Builds the document. Pure: the same code always builds the same document. */
export function buildOpenApiDocument(): OpenApiDocument {
	const paths: Record<string, Record<string, OperationObject>> = {};
	for (const operation of OPERATIONS) {
		const item = paths[operation.path] ?? {};
		item[operation.method] = operationObject(operation);
		paths[operation.path] = item;
	}
	return {
		openapi: "3.1.0",
		info: { title: "Alethia API", version: OPENAPI_DOCUMENT_VERSION, description: DESCRIPTION },
		servers: [{ url: "/", description: "The control plane that served this document." }],
		security: [{ bearerAuth: [] }],
		tags: Object.entries(OPERATION_TAGS).map(([name, description]) => ({ name, description })),
		paths,
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description: `A device-login token from \`alethia login\`, or a service token (\`${SERVICE_TOKEN_PREFIX}…\`).`,
				},
			},
			schemas: componentSchemas(OPERATIONS),
			headers: {
				RequestId: {
					description: "The request's id, minted by the server: `req_` and 32 lowercase hex digits.",
					schema: { type: "string", pattern: "^req_[0-9a-f]{32}$" },
				},
				MinCliVersion: {
					description: "The minimum CLI version this server accepts. Present only when the operator configured one.",
					schema: { type: "string" },
				},
			},
		},
	};
}
