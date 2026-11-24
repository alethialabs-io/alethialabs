// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The two things a person does for the `cli-demo` e2e dimension while it runs (#7454), done against
// the test database with the product's own code.
//
// WHY THIS EXISTS. Since AGT-L1 a service token's deploy or destroy follows table 4.2
// (lib/approvals/policy.ts): a deploy runs on its own only to an environment the token lists in
// `auto_approve_environment_ids` (decision D2), and a destroy always needs a person's approval. The
// demo authenticates with a service token (scripts/seed-cli-demo-token.mts), so two person-side steps
// now sit inside the run:
//
//   auto-approve  After the `env add` beat, list the run's environment on the token. In the product an
//                 org admin sets this on the token; nothing in the CLI can, by design, because a token
//                 that could widen its own list would approve itself.
//   approve       After `project destroy --no-wait` has requested an approval, decide it as a person.
//
// WHY THE APPROVAL GOES THROUGH decideApproval AND A REAL SESSION ROW. The console decides an approval
// in the `decideApplyApproval` server action (app/server/actions/approvals.ts), which reads the
// browser session and hands it to `decideApproval` (lib/approvals/decide.ts). A server action cannot
// be called from outside Next.js, so this script does what the action does and nothing else: it signs
// the approver in (a Better Auth `session` row), builds the same session-credential actor
// `currentActor` would, and calls the same engine inside `withActorScope`. Every rule the engine holds
// still applies: the PDP verb on the project, the fresh-sign-in limit, the binding to the plan, a
// different approver when the org requires one, and the typed environment name for a destroy. Nothing
// here writes `apply_approvals` directly, and no bypass exists in product code.
//
// WHO APPROVES. The org owner, the person who minted the token. The run's token acts as that profile,
// so this is the D2 situation exactly: a person sets up a token for CI and approves what it asks for.
// The org's "require a different approver" policy is off by default; if a run turns it on, the engine
// refuses with `self_approval`, and this script reports that rather than working around it. A second,
// separately seeded member would also need its grants mirrored into whichever PDP the console runs,
// which no seed here writes.
//
// Nothing is printed to stdout, and the token is never printed: the harness reads only the exit code
// and stderr.
//
// Usage:
//   tsx scripts/cli-demo-approval.mts auto-approve --creds <file> --project <project id> --env <env name>
//   tsx scripts/cli-demo-approval.mts approve --creds <file> --approval <approval id> --confirm-env <env name>

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { decideApproval } from "@/lib/approvals/decide";
import { getActiveScope } from "@/lib/auth/scope";
import { actorWithCredential } from "@/lib/authz/actor-credential";
import { resolveServiceToken } from "@/lib/cli/service-token";
import { getServiceDb, withActorScope } from "@/lib/db";
import { session } from "@/lib/db/schema/auth";
import { cliServiceTokens } from "@/lib/db/schema/cli-service-tokens";
import { projectEnvironments } from "@/lib/db/schema/project-environments";
import { projects } from "@/lib/db/schema/projects";

/** The file scripts/seed-cli-demo-token.mts writes. */
const credsSchema = z.object({ orgId: z.uuid(), ownerId: z.uuid(), token: z.string().min(1) });

type Creds = z.infer<typeof credsSchema>;

/** How long the approver's console session lives. It is signed out again as soon as the decision is made. */
const APPROVER_SESSION_MS = 10 * 60 * 1000;

/** Reads `--flag value` from argv; refuses a missing one, naming it. */
function required(name: string): string {
	const i = process.argv.indexOf(`--${name}`);
	const value = i !== -1 ? process.argv[i + 1] : undefined;
	if (!value || value.startsWith("--")) {
		throw new Error(`--${name} is required`);
	}
	return value;
}

/** Reads and validates the seeded credentials file. */
function readCreds(): Creds {
	const path = required("creds");
	const parsed = credsSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
	if (!parsed.success) {
		throw new Error(`${path} is not the file seed-cli-demo-token.mts writes: ${parsed.error.message}`);
	}
	return parsed.data;
}

/**
 * Lists the run's environment in the seeded token's `auto_approve_environment_ids`, so the demo's
 * deploy to it runs without an approval (decision D2). Refuses a production environment: the product
 * never deploys one automatically, so listing it would only make the deploy beat fail later.
 */
async function autoApprove(): Promise<void> {
	const creds = readCreds();
	const projectId = z.uuid().parse(required("project"));
	const envName = required("env");
	const db = getServiceDb();

	const identity = await resolveServiceToken(creds.token);
	if (!identity) {
		throw new Error("the seeded token does not resolve: it was revoked, expired, or minted in another database");
	}
	if (identity.organizationId !== creds.orgId) {
		throw new Error(`the seeded token is pinned to org ${identity.organizationId}, not ${creds.orgId}`);
	}

	const [env] = await db
		.select({ id: projectEnvironments.id, stage: projectEnvironments.stage })
		.from(projectEnvironments)
		.innerJoin(projects, eq(projects.id, projectEnvironments.project_id))
		.where(
			and(
				eq(projectEnvironments.project_id, projectId),
				eq(projectEnvironments.name, envName),
				eq(projects.org_id, creds.orgId),
			),
		)
		.limit(1);
	if (!env) {
		throw new Error(`project ${projectId} in org ${creds.orgId} has no environment named ${JSON.stringify(envName)}`);
	}
	if (env.stage === "production") {
		throw new Error(
			`environment ${JSON.stringify(envName)} is a production environment; a service token never deploys one without an approval (table 4.2)`,
		);
	}

	await db
		.update(cliServiceTokens)
		.set({
			auto_approve_environment_ids: sql`array_append(${cliServiceTokens.auto_approve_environment_ids}, ${env.id}::uuid)`,
		})
		.where(
			and(
				eq(cliServiceTokens.id, identity.tokenId),
				eq(cliServiceTokens.organization_id, creds.orgId),
				sql`not (${env.id}::uuid = any(${cliServiceTokens.auto_approve_environment_ids}))`,
			),
		);
	// Read back rather than trust the update: an update that matched nothing (the env was already
	// listed) and one that failed to apply look the same from its result.
	const [token] = await db
		.select({ ids: cliServiceTokens.auto_approve_environment_ids })
		.from(cliServiceTokens)
		.where(eq(cliServiceTokens.id, identity.tokenId))
		.limit(1);
	if (!token?.ids.includes(env.id)) {
		throw new Error(`token ${identity.tokenId} does not list environment ${env.id} after the update`);
	}
	process.stderr.write(`token ${identity.tokenId} deploys environment ${envName} (${env.id}) without an approval\n`);
}

/**
 * Approves approval `--approval` as the org owner, in a console session made for this decision and
 * signed out afterwards, through the engine the console's server action calls.
 */
async function approve(): Promise<void> {
	const creds = readCreds();
	const approvalId = z.uuid().parse(required("approval"));
	const confirmEnvironmentName = required("confirm-env");
	const db = getServiceDb();

	const scope = await getActiveScope(creds.ownerId, creds.orgId);
	if (scope.orgId !== creds.orgId) {
		throw new Error(`the approver ${creds.ownerId} resolves to org ${scope.orgId}, not ${creds.orgId}`);
	}
	const actor = actorWithCredential(scope, "session");

	const [signedIn] = await db
		.insert(session)
		.values({
			userId: creds.ownerId,
			token: randomBytes(32).toString("base64url"),
			expiresAt: new Date(Date.now() + APPROVER_SESSION_MS),
			userAgent: "alethia-e2e cli-demo approver",
			activeOrganizationId: creds.orgId,
		})
		.returning({ id: session.id, createdAt: session.createdAt });
	try {
		const result = await withActorScope(actor, (tx) =>
			decideApproval(
				tx,
				{ actor, sessionId: signedIn.id, sessionCreatedAt: signedIn.createdAt },
				approvalId,
				{ decision: "approve", confirmEnvironmentName },
			),
		);
		if (!result.ok) throw result.error;
		if (result.approval.status !== "approved") {
			throw new Error(`approval ${approvalId} is ${result.approval.status} after the decision, not approved`);
		}
		process.stderr.write(
			`approval ${approvalId} (${result.approval.operation} of environment ${confirmEnvironmentName}) approved by ${creds.ownerId}\n`,
		);
	} finally {
		await db.delete(session).where(eq(session.id, signedIn.id));
	}
}

/** Runs the subcommand named by the first argument. */
async function main(): Promise<void> {
	const sub = process.argv[2];
	if (sub === "auto-approve") return autoApprove();
	if (sub === "approve") return approve();
	throw new Error(`unknown subcommand ${JSON.stringify(sub)}: want auto-approve or approve`);
}

main().then(
	() => process.exit(0),
	(err) => {
		const code = err instanceof Error && "code" in err ? ` [${String(err.code)}]` : "";
		process.stderr.write(`cli-demo-approval failed${code}: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	},
);
