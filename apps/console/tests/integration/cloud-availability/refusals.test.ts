// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6811): the server refuses anything NEW on a cloud this deployment does not offer,
// against real Postgres, and leaves what already exists on such a cloud readable and removable.
//
// The offered set is fixed here by decision (2026-11-17): AWS, GCP, Azure and Hetzner are offered;
// Alibaba, DigitalOcean and Civo are not. An operator can re-enable one with
// ALETHIA_ENABLE_HIDDEN_CLOUDS; every test that needs that goes through `withHiddenClouds`.
//
// What a mock cannot show and this does: that a refusal leaves NO row behind (the pending
// identity, the project, its Fabric and environments), that a pending row stored before the
// offered set changed is neither handed back nor completed, and that disconnecting an account on
// such a cloud still unbinds its project. The same refusals for a cloud other than these three
// are in ./fixture-cloud.test.ts, which changes the catalog instead of the setting.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, expect, it, vi } from "vitest";

// Disconnect raises an ops alert; the alert pipeline is not this suite's subject.
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));

import { CloudNotOfferedError, withHiddenClouds } from "@/lib/cloud-providers/availability";
import {
	type CloudProvider,
	disconnectIdentity,
	getStatus,
	initIdentity,
	saveAlibabaIdentity,
	saveAwsIdentity,
	saveTokenCloudIdentity,
} from "@/lib/cloud-providers/connections";
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

const OFFERED = ["aws", "gcp", "azure", "hetzner"] as const;
const HIDDEN = ["alibaba", "digitalocean", "civo"] as const;

/** Every identity row this org holds for `provider`, pending or verified. */
async function identitiesOn(provider: CloudProvider) {
	return getServiceDb()
		.select({
			id: cloudIdentities.id,
			provider: cloudIdentities.provider,
			name: cloudIdentities.name,
			credentials: cloudIdentities.credentials,
			is_verified: cloudIdentities.is_verified,
		})
		.from(cloudIdentities)
		.where(and(eq(cloudIdentities.org_id, ORG), eq(cloudIdentities.provider, provider)));
}

/**
 * Deletes every identity row this org holds for `provider`, so a test starts from none. Every
 * foreign key to an identity is `set null` or `cascade`, so a project of an earlier test stays.
 */
async function clearIdentitiesOn(provider: CloudProvider): Promise<void> {
	await getServiceDb()
		.delete(cloudIdentities)
		.where(and(eq(cloudIdentities.org_id, ORG), eq(cloudIdentities.provider, provider)));
}

/**
 * Stores an identity row directly, the way a row written before the offered set changed is stored:
 * no entry point is asked, so it exists whatever is offered today.
 */
async function storeIdentity(provider: CloudProvider, verified: boolean): Promise<string> {
	const [row] = await getServiceDb()
		.insert(cloudIdentities)
		.values({
			user_id: USER,
			org_id: ORG,
			scope: "org",
			provider,
			name: `it-cloud-availability-${provider}`,
			credentials: verified ? { role_arn: "stored-before", account_id: "000000000000" } : {},
			is_verified: verified,
			status: verified ? "connected" : "pending",
		})
		.returning({ id: cloudIdentities.id });
	return row.id;
}

/** Creates a project bound to `identityId` through the one insert path every create runs. */
async function createProjectOn(identityId: string) {
	return getServiceDb().transaction((tx) =>
		insertProjectWithDefaultFabric(tx, {
			project_name: `it-ca-${randomUUID().slice(0, 8)}`,
			region: "eu-central-1",
			cloud_identity_id: identityId,
			iac_version: "1.11.4",
			environment_stage: "production",
			owner: USER,
			orgId: ORG,
		}),
	);
}

/** The ids of this org's projects bound to `identityId`. */
async function projectsOn(identityId: string): Promise<string[]> {
	const rows = await getServiceDb()
		.select({ id: projects.id })
		.from(projects)
		.where(and(eq(projects.org_id, ORG), eq(projects.cloud_identity_id, identityId)));
	return rows.map((r) => r.id);
}

/** Asks the existing-project check in a transaction of its own. */
async function checkProject(projectId: string): Promise<void> {
	await getServiceDb().transaction((tx) => assertProjectCloudOffered(tx, projectId));
}

describeIfDb("a cloud this deployment does not offer — refused for anything new (#6811)", () => {
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

	// ── Starting a connection ────────────────────────────────────────────────────────────────

	it.each(HIDDEN)("initIdentity refuses %s and stores no row", async (cloud) => {
		await clearIdentitiesOn(cloud);
		await expect(initIdentity(SCOPE, cloud)).rejects.toBeInstanceOf(CloudNotOfferedError);
		expect(await identitiesOn(cloud)).toEqual([]);
	});

	it.each(OFFERED)("initIdentity starts a pending row for %s", async (cloud) => {
		await clearIdentitiesOn(cloud);
		const { identityId } = await initIdentity(SCOPE, cloud);
		const rows = await identitiesOn(cloud);
		expect(rows.map((r) => r.id)).toEqual([identityId]);
		expect(rows[0]?.is_verified).toBe(false);
	});

	it.each(HIDDEN)("initIdentity starts one for %s once the operator setting names it", async (cloud) => {
		await clearIdentitiesOn(cloud);
		const { identityId } = await withHiddenClouds([cloud], () => initIdentity(SCOPE, cloud));
		expect((await identitiesOn(cloud)).map((r) => r.id)).toEqual([identityId]);
		// And the setting is not remembered: the same call is refused again without it.
		await expect(initIdentity(SCOPE, cloud)).rejects.toBeInstanceOf(CloudNotOfferedError);
	});

	it("re-enabling one cloud leaves the others refused", async () => {
		await clearIdentitiesOn("alibaba");
		await withHiddenClouds(["civo"], () =>
			expect(initIdentity(SCOPE, "alibaba")).rejects.toBeInstanceOf(CloudNotOfferedError),
		);
		expect(await identitiesOn("alibaba")).toEqual([]);
	});

	// ── A pending row stored before the offered set changed ──────────────────────────────────

	it("does not hand back a pending row that already exists for such a cloud", async () => {
		await clearIdentitiesOn("alibaba");
		const stored = await storeIdentity("alibaba", false);
		await expect(initIdentity(SCOPE, "alibaba")).rejects.toBeInstanceOf(CloudNotOfferedError);
		// Still there, untouched; with the cloud re-enabled it is the row that is reused.
		const reused = await withHiddenClouds(["alibaba"], () => initIdentity(SCOPE, "alibaba"));
		expect(reused.identityId).toBe(stored);
	});

	it("does not complete that pending row, through its own form or another cloud's", async () => {
		await clearIdentitiesOn("alibaba");
		const stored = await storeIdentity("alibaba", false);
		await expect(
			saveAlibabaIdentity(SCOPE, stored, "acs:ram::5123456789012345:role/R"),
		).rejects.toBeInstanceOf(CloudNotOfferedError);
		await expect(
			saveAwsIdentity(SCOPE, stored, "arn:aws:iam::123456789012:role/R"),
		).rejects.toBeInstanceOf(CloudNotOfferedError);
		const [row] = await identitiesOn("alibaba");
		expect(row).toMatchObject({ id: stored, provider: "alibaba", credentials: {}, is_verified: false });
		expect(row?.name).toBe("it-cloud-availability-alibaba");
	});

	it("does not complete a pending token-cloud row either", async () => {
		await clearIdentitiesOn("civo");
		const stored = await storeIdentity("civo", false);
		await expect(
			saveTokenCloudIdentity(SCOPE, stored, "civo", "t".repeat(24)),
		).rejects.toBeInstanceOf(CloudNotOfferedError);
		await expect(
			saveTokenCloudIdentity(SCOPE, stored, "hetzner", "t".repeat(24)),
		).rejects.toBeInstanceOf(CloudNotOfferedError);
		const [row] = await identitiesOn("civo");
		expect(row).toMatchObject({ id: stored, credentials: {}, is_verified: false });
	});

	// ── Creating a project ───────────────────────────────────────────────────────────────────

	it.each(HIDDEN)("refuses a project on a %s account, and stores none of it", async (cloud) => {
		await clearIdentitiesOn(cloud);
		const account = await storeIdentity(cloud, true);
		await expect(createProjectOn(account)).rejects.toBeInstanceOf(CloudNotOfferedError);
		expect(await projectsOn(account)).toEqual([]);
	});

	it("creates a project on an offered cloud's account", async () => {
		await clearIdentitiesOn("aws");
		const account = await storeIdentity("aws", true);
		const { project } = await createProjectOn(account);
		expect(await projectsOn(account)).toEqual([project.id]);
	});

	it.each(HIDDEN)("creates one on a %s account once the operator setting names it", async (cloud) => {
		await clearIdentitiesOn(cloud);
		const account = await storeIdentity(cloud, true);
		const { project } = await withHiddenClouds([cloud], () => createProjectOn(account));
		expect(await projectsOn(account)).toEqual([project.id]);
	});

	// ── What already exists on such a cloud ──────────────────────────────────────────────────

	it("refuses plan and deploy for an existing project on such a cloud, and only for that one", async () => {
		await clearIdentitiesOn("alibaba");
		await clearIdentitiesOn("aws");
		const hiddenAccount = await storeIdentity("alibaba", true);
		const offeredAccount = await storeIdentity("aws", true);
		const { project: onHidden } = await withHiddenClouds(["alibaba"], () => createProjectOn(hiddenAccount));
		const { project: onOffered } = await createProjectOn(offeredAccount);

		await expect(checkProject(onHidden.id)).rejects.toBeInstanceOf(CloudNotOfferedError);
		await expect(checkProject(onOffered.id)).resolves.toBeUndefined();
		await expect(
			withHiddenClouds(["alibaba"], () => checkProject(onHidden.id)),
		).resolves.toBeUndefined();
		await expect(checkProject(randomUUID())).resolves.toBeUndefined();
	});

	it("still reads an account on such a cloud, and still disconnects it", async () => {
		await clearIdentitiesOn("alibaba");
		const account = await storeIdentity("alibaba", true);
		const { project } = await withHiddenClouds(["alibaba"], () => createProjectOn(account));

		expect(await getStatus(SCOPE, "alibaba")).toMatchObject({ connected: true, identityId: account });

		await expect(disconnectIdentity(SCOPE, account, "alibaba")).resolves.toEqual({ success: true });
		expect(await projectsOn(account)).toEqual([]);
		const [row] = await getServiceDb()
			.select({ cloud_identity_id: projects.cloud_identity_id })
			.from(projects)
			.where(eq(projects.id, project.id));
		expect(row?.cloud_identity_id).toBeNull();
		expect(await getStatus(SCOPE, "alibaba")).toEqual({ connected: false });
	});
});
