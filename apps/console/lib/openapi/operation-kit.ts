// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";
import type { Action, Resource } from "@/lib/authz/registry";

/**
 * The vocabulary of the operation table (lib/openapi/operations.ts and the per-family tables it
 * gathers): what one documented operation says, and the answers and parameters many of them share.
 */

/** An HTTP method a route module exports, in OpenAPI's lowercase spelling. */
export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";

/** A query parameter an operation reads. */
export interface QueryParameter {
	readonly name: string;
	readonly description: string;
	readonly schema: z.ZodType;
}

/** A request header an operation reads itself, beyond the ones every operation accepts. */
export interface HeaderParameter {
	readonly name: string;
	readonly description: string;
	/** True when the route refuses a request without it. */
	readonly required?: boolean;
}

/** One answer an operation gives. */
export interface OperationResponse {
	readonly status: number;
	readonly description: string;
	/**
	 * The wire-contract schema `cliJson` checks this answer against. Absent for an error answer
	 * (the shared error body) and for a success answer the route builds without `cliJson`, which
	 * `uncontracted` then has to say.
	 */
	readonly schema?: z.ZodType;
	/**
	 * True for a success answer that is NOT checked against the wire contract — the route builds it
	 * with `NextResponse.json`. The document says so rather than inventing a schema for it.
	 */
	readonly uncontracted?: boolean;
	/** True for an answer with no body at all (a `304 Not Modified`). */
	readonly empty?: boolean;
}

/** The permission an operation asks, as the route hands it to `authorizeCli`. */
export interface OperationPermission {
	readonly action: Action;
	readonly resource: Resource;
}

/**
 * What an operation asks before it acts:
 * - one permission, the `(action, resource)` the route hands `authorizeCli` (or, on the cloud
 *   connector routes, `enforceProviderPermission`);
 * - a permission chosen by one field of the body (`job_type` on `POST /api/jobs`, `tier` on a
 *   kubeconfig mint), one per value;
 * - `credentialOnly`: a valid credential and no permission at all — the route reads nothing of the
 *   organization's and acts only with what the request itself carries.
 */
export type OperationAuthorization =
	| OperationPermission
	| {
			readonly perField: {
				readonly field: string;
				readonly cases: Readonly<Record<string, OperationPermission>>;
			};
	  }
	| { readonly credentialOnly: true };

/** One documented operation. */
export interface OpenApiOperation {
	readonly method: HttpMethod;
	/** The OpenAPI path template. The route file is this path with `{x}` written `[x]`. */
	readonly path: string;
	readonly operationId: string;
	readonly tag: OperationTag;
	readonly summary: string;
	readonly description?: string;
	readonly permission: OperationAuthorization;
	/** What each path parameter means, where the document's defaults do not say it. */
	readonly pathParameters?: Readonly<Record<string, string>>;
	readonly query?: readonly QueryParameter[];
	/** Request headers the route reads itself. */
	readonly headers?: readonly HeaderParameter[];
	/** The request body: the route's own validator, or — with `bodyUnvalidated` — the fields it reads. */
	readonly body?: z.ZodType;
	/**
	 * True when the route reads its JSON body WITHOUT a validator, so `body` is not a schema the route
	 * runs but the list of fields it reads, which the drift test holds to the route's code.
	 */
	readonly bodyUnvalidated?: boolean;
	/** True when the route honours `If-Match: <revision>` (the component's `updated_at`). */
	readonly ifMatch?: boolean;
	readonly responses: readonly OperationResponse[];
}

/** The tags, in the order the document lists them. */
export const OPERATION_TAGS = {
	Jobs: "Plan, deploy and destroy jobs: queue one, follow it, read its logs, cancel it.",
	Projects:
		"Projects and what is in them: environments, components, add-ons, BYO charts and IaC, the design document, and read models (cost, drift, probes, promotions, protection, staged changes).",
	Configurations: "A project's flattened configuration, as the CLI reads and exports it.",
	Clusters: "Project clusters, and short-lived kubeconfigs for them.",
	Catalog: "The component kinds and the add-on catalog a design is checked against. No tenant data.",
	Account: "Who the caller is, the organizations they belong to, and the active organization's settings, billing, usage, activity, agents and receipt-signing keys.",
	Access: "Members, invitations, teams, roles, access grants, SSO providers and service tokens. Administration of the organization.",
	Classification: "The organization's classification taxonomy, and the values assigned to a resource.",
	"Cloud accounts": "Connected cloud accounts: list them, read what was discovered in them, and connect, verify or disconnect one.",
	Repositories: "Repositories at a Git provider, listed with the caller's own token for that provider.",
	Runners: "Runners that execute jobs, and the managed fleet's warm pools.",
	Alerts: "Alert rules and the notification channels they deliver to.",
} as const;

/** One of {@link OPERATION_TAGS}. */
export type OperationTag = keyof typeof OPERATION_TAGS;

/** `?env=` on a project route. */
export const envQuery: QueryParameter = {
	name: "env",
	description: "The environment, by id or name. Omitted: the project's default environment.",
	schema: z.string(),
};

/** `?limit=` and `?cursor=` on a cursor-paged list (lib/cli/paging.ts). */
export const pageQuery: readonly QueryParameter[] = [
	{
		name: "limit",
		description: "Page size, a positive integer. Default 50; values above 200 are served as 200. `page.limit` echoes what was served.",
		schema: z.string().regex(/^\d+$/),
	},
	{
		name: "cursor",
		description: "The `page.next_cursor` of the previous page. Empty or omitted: the first page. A cursor is bound to its list and organization.",
		schema: z.string(),
	},
];

/** The project path parameter's meaning, shared by every project route. */
export const PROJECT_ID_DESCRIPTION = "The project, by id, name or slug, within the caller's organization.";

/** Shared error answers. */
export const badRequest: OperationResponse = { status: 400, description: "The request is malformed; `error` names what is wrong." };
export const notFound: OperationResponse = {
	status: 404,
	description: "Not found, or not visible to this caller. The two are answered the same way.",
};
export const forbidden: OperationResponse = { status: 403, description: "The caller may not do this." };
export const conflict: OperationResponse = { status: 409, description: "The resource's current state refuses the request." };
export const serverError: OperationResponse = { status: 500, description: "The server failed." };

/** A 200 or 201 checked against `schema`. */
export function ok(schema: z.ZodType, description: string, status = 200): OperationResponse {
	return { status, description, schema };
}

/** A success answer the route builds without the wire contract; `description` says what it holds. */
export function uncontracted(description: string, status = 200): OperationResponse {
	return { status, description, uncontracted: true };
}
