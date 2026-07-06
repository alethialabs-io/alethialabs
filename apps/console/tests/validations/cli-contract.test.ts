// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
	cliCloudIdentitiesResponse,
	cliClustersResponse,
	cliJobLogsResponse,
	cliJobResponse,
	cliJobsPageResponse,
	cliRepositoriesResponse,
	cliLatestReleaseWire,
	cliRunnersResponse,
	connectIdentityWire,
	deployRunnerWire,
	initIdentityWire,
	jobWire,
	providerStatusWire,
} from "@/lib/validations/cli-contract";

// The CLI wire fixtures live next to the Go contract test (packages/core/api/
// testdata) and are decoded there into the Go structs the CLI uses. This suite
// is the other half of the guard: it asserts every fixture still satisfies the
// Zod contract. So when the DB schema (and thus the contract) changes, a stale
// fixture fails here — and once regenerated, the new fixture fails the Go strict
// decode until the Go struct is updated. Neither side can drift silently.
const fixturesDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../packages/core/api/testdata",
);

function loadFixture(name: string): unknown {
	return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

const cases: ReadonlyArray<[string, z.ZodType]> = [
	["runners.json", cliRunnersResponse],
	["clusters.json", cliClustersResponse],
	["cloud_identities.json", cliCloudIdentitiesResponse],
	["jobs_page.json", cliJobsPageResponse],
	["job.json", jobWire],
	["job_logs.json", cliJobLogsResponse],
	["repositories.json", cliRepositoriesResponse],
	["provider_status.json", providerStatusWire],
	["deploy_runner.json", deployRunnerWire],
	["latest_release.json", cliLatestReleaseWire],
	["job_response.json", cliJobResponse],
	["init_identity.json", initIdentityWire],
	["connect_identity.json", connectIdentityWire],
];

describe("CLI wire contract ↔ fixtures", () => {
	it.each(cases)("%s conforms to its contract schema", (file, schema) => {
		const result = schema.safeParse(loadFixture(file));
		if (!result.success) {
			throw new Error(
				`${file} violates its CLI wire contract:\n${JSON.stringify(result.error.issues, null, 2)}`,
			);
		}
		expect(result.success).toBe(true);
	});
});
