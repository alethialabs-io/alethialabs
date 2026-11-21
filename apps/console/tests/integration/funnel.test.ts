// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the funnel SQL (REL-L12, #6913) against real Postgres — the first-time-per-subject
// rule, the status and job filters, the per-cloud attribution and the UTC day buckets, none of which
// a mocked `execute` can measure.
//
// The funnel counts across EVERY tenant, so it cannot be scoped to this test's rows the way the
// other suites scope by org id. Instead every row is dated inside a week in March 1999, which no
// other suite seeds (their rows default to now()), and the report is asked about exactly that week.
// One row per stage is dated just OUTSIDE it, so the window bound is measured too.

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities, invoice, jobs, organization, projects, user } from "@/lib/db/schema";
import { queryFunnel } from "@/lib/queries/funnel";
import { describeIfDb } from "./db";

const at = (iso: string) => new Date(iso);
const USERS = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const [U1, U2, U3, U_BEFORE] = USERS;
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const identityIds: string[] = [];
const projectIds: string[] = [];
const jobIds: string[] = [];
const invoiceIds: string[] = [];

describeIfDb("queryFunnel against real Postgres", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(user).values([
			{ id: U1, email: `it-funnel-${U1}@example.test`, createdAt: at("1999-03-02T09:00:00Z") },
			{ id: U2, email: `it-funnel-${U2}@example.test`, createdAt: at("1999-03-02T23:59:59Z") },
			{ id: U3, email: `it-funnel-${U3}@example.test`, createdAt: at("1999-03-05T00:00:00Z") },
			// The day before the window: not counted.
			{ id: U_BEFORE, email: `it-funnel-${U_BEFORE}@example.test`, createdAt: at("1999-02-28T23:59:59Z") },
		]);
		await db.insert(organization).values([
			{ id: ORG_A, name: `it-funnel-a-${ORG_A.slice(0, 8)}`, createdAt: at("1999-03-02T10:00:00Z") },
			{ id: ORG_B, name: `it-funnel-b-${ORG_B.slice(0, 8)}`, createdAt: at("1999-03-05T10:00:00Z") },
		]);

		const identities = await db
			.insert(cloudIdentities)
			.values([
				// A's first verified AWS identity: counted on the 3rd.
				{ user_id: U1, org_id: ORG_A, provider: "aws", status: "connected", created_at: at("1999-03-03T12:00:00Z") },
				// A's second AWS identity: same (org, cloud), so not counted again.
				{ user_id: U1, org_id: ORG_A, provider: "aws", status: "connected", created_at: at("1999-03-04T12:00:00Z") },
				// Never verified: not counted.
				{ user_id: U1, org_id: ORG_A, provider: "gcp", status: "pending", created_at: at("1999-03-04T12:00:00Z") },
				// Degraded still verified: B's GCP, counted on the 6th.
				{ user_id: U3, org_id: ORG_B, provider: "gcp", status: "degraded", created_at: at("1999-03-06T12:00:00Z") },
			])
			.returning({ id: cloudIdentities.id });
		identityIds.push(...identities.map((i) => i.id));
		const [awsA] = identityIds;

		const projectRows = await db
			.insert(projects)
			.values([
				{ user_id: U1, org_id: ORG_A, cloud_identity_id: awsA, project_name: `it-funnel-${ORG_A.slice(0, 8)}-1`, region: "eu-west-1", iac_version: "1", created_at: at("1999-03-04T08:00:00Z") },
				{ user_id: U1, org_id: ORG_A, cloud_identity_id: awsA, project_name: `it-funnel-${ORG_A.slice(0, 8)}-2`, region: "eu-west-1", iac_version: "1", created_at: at("1999-03-05T08:00:00Z") },
				// No cloud identity yet: counted under no cloud.
				{ user_id: U3, org_id: ORG_B, project_name: `it-funnel-${ORG_B.slice(0, 8)}-1`, region: "eu-central", iac_version: "1", created_at: at("1999-03-06T08:00:00Z") },
			])
			.returning({ id: projects.id });
		projectIds.push(...projectRows.map((p) => p.id));

		const jobRows = await db
			.insert(jobs)
			.values([
				// A failed deploy first, then the first successful one on the 5th.
				{ user_id: U1, org_id: ORG_A, cloud_identity_id: awsA, provider: "aws", job_type: "DEPLOY", status: "FAILED", completed_at: at("1999-03-04T15:00:00Z") },
				{ user_id: U1, org_id: ORG_A, cloud_identity_id: awsA, provider: "aws", job_type: "DEPLOY", status: "SUCCESS", completed_at: at("1999-03-05T15:00:00Z") },
				{ user_id: U1, org_id: ORG_A, cloud_identity_id: awsA, provider: "aws", job_type: "DEPLOY", status: "SUCCESS", completed_at: at("1999-03-06T15:00:00Z") },
				// A successful PLAN is not a deploy.
				{ user_id: U1, org_id: ORG_A, cloud_identity_id: awsA, provider: "aws", job_type: "PLAN", status: "SUCCESS", completed_at: at("1999-03-03T15:00:00Z") },
			])
			.returning({ id: jobs.id });
		jobIds.push(...jobRows.map((j) => j.id));

		const invoiceRows = await db
			.insert(invoice)
			.values([
				{ organizationId: ORG_A, stripeInvoiceId: `in_it_funnel_${ORG_A.slice(0, 12)}_1`, status: "paid", amountTotal: 2000, currency: "eur", paidAt: at("1999-03-06T20:00:00Z") },
				{ organizationId: ORG_A, stripeInvoiceId: `in_it_funnel_${ORG_A.slice(0, 12)}_2`, status: "paid", amountTotal: 2000, currency: "eur", paidAt: at("1999-03-07T20:00:00Z") },
			])
			.returning({ id: invoice.id });
		invoiceIds.push(...invoiceRows.map((i) => i.id));
	});

	afterAll(async () => {
		const db = getServiceDb();
		if (jobIds.length) await db.delete(jobs).where(inArray(jobs.id, jobIds));
		if (projectIds.length) await db.delete(projects).where(inArray(projects.id, projectIds));
		if (identityIds.length) await db.delete(cloudIdentities).where(inArray(cloudIdentities.id, identityIds));
		if (invoiceIds.length) await db.delete(invoice).where(inArray(invoice.id, invoiceIds));
		await db.delete(organization).where(inArray(organization.id, [ORG_A, ORG_B]));
		await db.delete(user).where(inArray(user.id, USERS));
	});

	it("counts each stage the first time it is reached, per UTC day and per cloud", async () => {
		const report = await queryFunnel(getServiceDb(), {
			now: at("1999-03-07T12:00:00Z"),
			days: 7,
		});
		expect(report.from).toBe("1999-03-01");
		expect(report.to).toBe("1999-03-07");
		expect(report.cells).toEqual([
			{ day: "1999-03-02", stage: "signed_up", cloud: null, count: 2 },
			{ day: "1999-03-02", stage: "organization_created", cloud: null, count: 1 },
			{ day: "1999-03-03", stage: "cloud_connected", cloud: "aws", count: 1 },
			{ day: "1999-03-04", stage: "project_created", cloud: "aws", count: 1 },
			{ day: "1999-03-05", stage: "signed_up", cloud: null, count: 1 },
			{ day: "1999-03-05", stage: "organization_created", cloud: null, count: 1 },
			{ day: "1999-03-05", stage: "first_deploy", cloud: "aws", count: 1 },
			{ day: "1999-03-06", stage: "cloud_connected", cloud: "gcp", count: 1 },
			{ day: "1999-03-06", stage: "project_created", cloud: null, count: 1 },
			{ day: "1999-03-06", stage: "subscribed", cloud: null, count: 1 },
		]);
	});

	it("a narrower window that starts after a subject's first time does not count its later events", async () => {
		// From the 5th: A's second AWS project (the 5th), its second deploy (the 6th) and second
		// invoice (the 7th) are all repeats, so none of them appear.
		const report = await queryFunnel(getServiceDb(), {
			now: at("1999-03-07T12:00:00Z"),
			days: 3,
		});
		expect(report.from).toBe("1999-03-05");
		expect(report.totals).toEqual([
			{ stage: "signed_up", cloud: null, count: 1 },
			{ stage: "organization_created", cloud: null, count: 1 },
			{ stage: "cloud_connected", cloud: "gcp", count: 1 },
			{ stage: "project_created", cloud: null, count: 1 },
			{ stage: "first_deploy", cloud: "aws", count: 1 },
			{ stage: "subscribed", cloud: null, count: 1 },
		]);
	});
});
