// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Generates the Go CLI contract fixtures (packages/core/api/testdata/*.json)
// from the Zod wire contract. The contract (lib/validations/cli-contract.ts) is
// the single source of truth: this turns each schema into JSON Schema via
// z.toJSONSchema and deterministically samples one representative value, so the
// fixtures can never silently diverge from the contract. The Go strict-decode
// test (packages/core/api/contract_test.go) then proves the hand-curated Go
// structs match those fixtures. A DB change flows: schema → contract → here →
// fixture diff (CI git-diff) → Go test names the field to add.
//
// Determinism is essential — fixed values, schema property order, no randomness —
// so `git diff` only fires on a real contract change. Run: pnpm -F console gen:cli-fixtures

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { cliContract } from "@/lib/validations/cli-contract";
import { toArray } from "@/lib/coerce";
import { asRecord } from "@/lib/records";
import { typedEntries } from "@/lib/typed-object";

// Fixed sample values (deterministic). The UUID is a valid v4 that also satisfies
// drizzle-zod's strict uuid pattern; the timestamp satisfies z.iso.datetime.
const SAMPLE_UUID = "00000000-0000-4000-8000-000000000000";
const SAMPLE_TS = "2026-01-01T00:00:00.000Z";

type JsonSchema = Record<string, unknown>;

/** Resolves a local $ref against the root document's $defs/definitions. */
function deref(schema: unknown, root: JsonSchema): JsonSchema | undefined {
	if (!schema || typeof schema !== "object") return undefined;
	const s = asRecord(schema);
	if (typeof s.$ref === "string") {
		const segments = s.$ref.replace(/^#\//, "").split("/");
		let cur: unknown = root;
		for (const seg of segments) cur = asRecord(cur)[seg];
		return cur && typeof cur === "object" ? asRecord(cur) : undefined;
	}
	return s;
}

/** Deterministically samples one valid value for a JSON Schema node. */
function sample(node: unknown, root: JsonSchema): unknown {
	const schema = deref(node, root);
	if (!schema) return null;

	// Unions (nullable renders as anyOf:[X, {type:null}]) — take the first non-null branch.
	const union = toArray(schema.anyOf ?? schema.oneOf);
	if (union.length > 0) {
		const nonNull =
			union.find((b) => deref(b, root)?.type !== "null") ?? union[0];
		return sample(nonNull, root);
	}

	if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

	const typeVal = schema.type;
	const type = Array.isArray(typeVal)
		? (typeVal.find((t) => t !== "null") ?? typeVal[0])
		: typeVal;

	switch (type) {
		case "object": {
			const props = asRecord(schema.properties);
			if (Object.keys(props).length > 0) {
				// Emit every property (ignore `required`) so optional/nullable fields
				// the Go struct models are always present — keeps the Go reverse-check green.
				const out: Record<string, unknown> = {};
				for (const [key, child] of Object.entries(props)) out[key] = sample(child, root);
				return out;
			}
			return {}; // open record (z.record / z.unknown)
		}
		case "array":
			return [sample(schema.items ?? {}, root)];
		case "string":
			if (schema.format === "uuid") return SAMPLE_UUID;
			if (schema.format === "date-time") return SAMPLE_TS;
			return "string";
		case "integer":
		case "number":
			return 0;
		case "boolean":
			return false;
		case "null":
			return null;
		default:
			return null;
	}
}

// contract registry key → fixture filename in packages/core/api/testdata/.
const FIXTURES: Record<keyof typeof cliContract, string> = {
	RunnersResponse: "runners.json",
	ClustersResponse: "clusters.json",
	ClusterDetailResponse: "cluster_detail.json",
	CloudIdentitiesResponse: "cloud_identities.json",
	JobsPageResponse: "jobs_page.json",
	JobResponse: "job_response.json",
	Job: "job.json",
	JobLogsResponse: "job_logs.json",
	RepositoriesResponse: "repositories.json",
	ProviderStatus: "provider_status.json",
	InitIdentity: "init_identity.json",
	ConnectIdentity: "connect_identity.json",
	DeployRunnerResponse: "deploy_runner.json",
	LatestRelease: "latest_release.json",
	WhoAmI: "whoami.json",
	OrgsResponse: "orgs.json",
	MembersResponse: "members.json",
	TeamsResponse: "teams.json",
	ChannelsResponse: "channels.json",
	ChannelResponse: "channel.json",
	AlertRulesResponse: "alert_rules.json",
	AlertRuleResponse: "alert_rule.json",
	ActivityResponse: "activity.json",
	RolesResponse: "roles.json",
	RoleResponse: "role.json",
	GrantsResponse: "grants.json",
	GrantResponse: "grant.json",
	SsoProvidersResponse: "sso_providers.json",
	SsoProviderResponse: "sso_provider.json",
	BillingResponse: "billing.json",
	UsageResponse: "usage.json",
	FleetPoolsResponse: "fleet_pools.json",
	FleetPoolResponse: "fleet_pool.json",
	ProjectResponse: "project.json",
	EnvironmentsResponse: "environments.json",
	EnvironmentResponse: "environment.json",
	ComponentsResponse: "components.json",
	ComponentResponse: "component.json",
	ClassificationDimensionsResponse: "classification_dimensions.json",
	ClassificationAssignmentsResponse: "classification_assignments.json",
};

const testdataDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../packages/core/api/testdata",
);
mkdirSync(testdataDir, { recursive: true });

for (const [key, file] of typedEntries(FIXTURES)) {
	const js = asRecord(z.toJSONSchema(cliContract[key], { target: "draft-7" }));
	const value = sample(js, js);
	writeFileSync(join(testdataDir, file), `${JSON.stringify(value, null, "\t")}\n`);
	console.log(`wrote testdata/${file}`);
}

console.log(`\n${Object.keys(FIXTURES).length} fixtures generated from the CLI contract.`);
