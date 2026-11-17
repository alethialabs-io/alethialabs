// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6811): the refusals follow the catalog's `availability` FIELD, not a cloud's name.
//
// ./refusals.test.ts runs against the catalog as it is checked in, where the clouds that are not
// offered are Alibaba, DigitalOcean and Civo. A server that refused those three by name would pass
// every test there. So this file changes the field instead and leaves the code alone: GCP is the
// fixture cloud, marked `hidden`, and Alibaba is marked `available`. Nothing else differs.
//
// With that catalog the same two entry points must refuse GCP and accept Alibaba with no operator
// setting, and the setting must re-enable GCP, the cloud it was never written for.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";

vi.mock("@/lib/cloud-providers/generated/catalog", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cloud-providers/generated/catalog")>();
	const availability: typeof actual.CLOUD_AVAILABILITY = {
		...actual.CLOUD_AVAILABILITY,
		gcp: "hidden",
		alibaba: "available",
	};
	return { ...actual, CLOUD_AVAILABILITY: availability };
});

import {
	CloudNotOfferedError,
	offeredClouds,
	withHiddenClouds,
} from "@/lib/cloud-providers/availability";
import { type CloudProvider, initIdentity } from "@/lib/cloud-providers/connections";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	projectEnvironments,
	projectFabrics,
	projects,
	resourceHierarchy,
} from "@/lib/db/schema";
import { assertProjectCloudOffered, insertProjectWithDefaultFabric } from "@/lib/queries/projects";
import { describeIfDb } from "../db";

const ORG = randomUUID();
const USER = randomUUID();
const SCOPE = { userId: USER, orgId: ORG };

/** The ids of this org's identity rows for `provider`. */
async function identityIdsOn(provider: CloudProvider): Promise<string[]> {
	const rows = await getServiceDb()
		.select({ id: cloudIdentities.id })
		.from(cloudIdentities)
		.where(and(eq(cloudIdentities.org_id, ORG), eq(cloudIdentities.provider, provider)));
	return rows.map((r) => r.id);
}

/** Stores a verified account row directly, as one written before the catalog changed would be. */
async function storeAccount(provider: CloudProvider): Promise<string> {
	const [row] = await getServiceDb()
		.insert(cloudIdentities)
		.values({
			user_id: USER,
			org_id: ORG,
			scope: "org",
			provider,
			name: `it-fixture-cloud-${provider}-${randomUUID().slice(0, 8)}`,
			credentials: {},
			is_verified: true,
			status: "connected",
		})
		.returning({ id: cloudIdentities.id });
	return row.id;
}

/** Creates a project bound to `identityId` through the one insert path every create runs. */
async function createProjectOn(identityId: string) {
	return getServiceDb().transaction((tx) =>
		insertProjectWithDefaultFabric(tx, {
			project_name: `it-fc-${randomUUID().slice(0, 8)}`,
			region: "eu-central-1",
			cloud_identity_id: identityId,
			iac_version: "1.11.4",
			environment_stage: "production",
			owner: USER,
			orgId: ORG,
		}),
	);
}

/** How many projects this org has bound to `identityId`. */
async function projectCountOn(identityId: string): Promise<number> {
	const rows = await getServiceDb()
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.org_id, ORG), eq(projects.cloud_identity_id, identityId)));
	return rows.length;
}

describeIfDb("the refusals follow the availability field — GCP hidden, Alibaba available (#6811)", () => {
	afterAll(async () => {
		const db = getServiceDb();
		const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.org_id, ORG));
		const ids = rows.map((r) => r.id);
		if (ids.length > 0) {
			await db.delete(projectEnvironments).where(inArray(projectEnvironments.project_id, ids));
			await db.delete(projectFabrics).where(inArray(projectFabrics.project_id, ids));
			await db
				.delete(resourceHierarchy)
				.where(and(eq(resourceHierarchy.child_type, "project"), inArray(resourceHierarchy.child_id, ids)));
			await db.delete(projects).where(eq(projects.org_id, ORG));
		}
		await db.delete(cloudIdentities).where(eq(cloudIdentities.org_id, ORG));
	});

	it("reads the fixture catalog: GCP is out of the offered set and Alibaba is in it", () => {
		// If the mock above ever stops applying, every test below would run against the real
		// catalog and the refusals of GCP would fail for a reason that has nothing to do with them.
		expect(offeredClouds()).toEqual(["aws", "azure", "alibaba", "hetzner"]);
	});

	it("initIdentity refuses the fixture cloud and stores no row", async () => {
		await expect(initIdentity(SCOPE, "gcp")).rejects.toBeInstanceOf(CloudNotOfferedError);
		await expect(initIdentity(SCOPE, "gcp")).rejects.toThrow(/^Google Cloud Platform is not available in this release\.$/);
		expect(await identityIdsOn("gcp")).toEqual([]);
	});

	it("initIdentity accepts Alibaba with no operator setting", async () => {
		const { identityId } = await initIdentity(SCOPE, "alibaba");
		expect(await identityIdsOn("alibaba")).toEqual([identityId]);
	});

	it("initIdentity accepts the fixture cloud once the operator setting names it", async () => {
		const { identityId } = await withHiddenClouds(["gcp"], () => initIdentity(SCOPE, "gcp"));
		expect(await identityIdsOn("gcp")).toEqual([identityId]);
	});

	it("refuses a project on a fixture-cloud account, and stores none of it", async () => {
		const account = await storeAccount("gcp");
		await expect(createProjectOn(account)).rejects.toBeInstanceOf(CloudNotOfferedError);
		expect(await projectCountOn(account)).toBe(0);
	});

	it("creates a project on an Alibaba account with no operator setting", async () => {
		const account = await storeAccount("alibaba");
		await createProjectOn(account);
		expect(await projectCountOn(account)).toBe(1);
	});

	it("creates one on a fixture-cloud account once the operator setting names it, and then refuses plan and deploy without it", async () => {
		const account = await storeAccount("gcp");
		const { project } = await withHiddenClouds(["gcp"], () => createProjectOn(account));
		expect(await projectCountOn(account)).toBe(1);
		await expect(
			getServiceDb().transaction((tx) => assertProjectCloudOffered(tx, project.id)),
		).rejects.toBeInstanceOf(CloudNotOfferedError);
	});
});
