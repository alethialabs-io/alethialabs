// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runners domain — permission / gate / error paths.
//   • Hobby (community) org is gated behind the byoRunners entitlement in hosted mode → upsell.
//   • Destroy queues a DESTROY_RUNNER job for a deployed runner (stops at QUEUED — no real tofu).

import { test, expect } from "../fixtures/qa";
import { db } from "../helpers/db";

// Cold-compiled Next dev bundle on first hit — give navigation-heavy flows headroom over the 30s default.
test.describe.configure({ timeout: 90_000 });

/** Seeds a connected cloud identity for the team org so a deployed runner can reference it. */
async function seedIdentity(teamUserId: string, teamOrgId: string): Promise<{ id: string }> {
	const sql = db();
	const [row] = await sql<{ id: string }[]>`
		insert into cloud_identities ${sql({
			user_id: teamUserId,
			org_id: teamOrgId,
			scope: "org",
			provider: "aws",
			name: `e2e-runner-destroy-${Date.now()}`,
			credentials: sql.json({ role_arn: "arn:aws:iam::123456789012:role/e2e" }),
			is_verified: true,
			status: "connected",
			verified_account_id: "123456789012",
		})}
		returning id`;
	return row;
}

/** Seeds a self-operated, deployed runner with a cloud identity + deploy_config → shows Destroy. */
async function seedDeployedRunner(
	teamUserId: string,
	teamOrgId: string,
	name: string,
	cloudIdentityId: string,
): Promise<{ id: string }> {
	const sql = db();
	const [row] = await sql<{ id: string }[]>`
		insert into runners ${sql({
			user_id: teamUserId,
			org_id: teamOrgId,
			name,
			operator: "self",
			provisioning: "deployed",
			token_hash: `e2e-hash-${Math.random().toString(36).slice(2)}`,
			status: "ONLINE",
			cloud_identity_id: cloudIdentityId,
			metadata: sql.json({
				deploy_config: {
					region: "eu-central-1",
					cloud_provider: "aws",
					image_tag: "latest",
					runner_token: "e2e-token",
				},
			}),
		})}
		returning id`;
	return row;
}

test.describe("Runners — entitlement gate (Hobby)", () => {
	test("Hobby org is gated and shown the byoRunners upsell instead of the runner surface", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/~/runners`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByText("Bring your own runners")).toBeVisible({ timeout: 15_000 });
		// The team plan surfaces as "Pro" in the plan catalog.
		await expect(owner.page.getByText(/Available on the Pro plan\./)).toBeVisible();
	});

	test("the gated Hobby surface offers no Add runner action", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/runners`);
		await expect(owner.page.getByText("Bring your own runners")).toBeVisible({ timeout: 15_000 });
		await expect(owner.page.getByRole("button", { name: "Add runner" })).toHaveCount(0);
	});
});

test.describe("Runners — destroy queues a job", () => {
	let identityId: string | null = null;
	let runnerId: string | null = null;

	test.afterEach(async ({ team }) => {
		const sql = db();
		if (runnerId) await sql`delete from runners where id = ${runnerId}`;
		if (identityId) {
			await sql`delete from jobs where cloud_identity_id = ${identityId}`;
			await sql`delete from cloud_identities where id = ${identityId}`;
		}
		await sql`delete from runners where user_id = ${team.userId!} and name like 'e2e-%'`;
		identityId = null;
		runnerId = null;
	});

	test("destroying a deployed runner queues a DESTROY_RUNNER job", async ({ team }) => {
		const name = `e2e-destroy-${Date.now()}`;
		const identity = await seedIdentity(team.userId!, team.orgId!);
		identityId = identity.id;
		const runner = await seedDeployedRunner(team.userId!, team.orgId!, name, identity.id);
		runnerId = runner.id;

		await team.page.goto(`/${team.orgSlug}/~/runners`);
		const card = team.page.locator('[data-slot="card"]').filter({ hasText: name });
		await expect(card).toBeVisible({ timeout: 15_000 });

		// Open the destroy popover from the card, then confirm.
		await card.getByRole("button", { name: "Destroy" }).click();
		await expect(team.page.getByText("Select runner")).toBeVisible();
		// The Confirm control shares the "Destroy" label; it is the one inside the popover (last in DOM).
		await team.page.getByRole("button", { name: "Destroy" }).last().click();

		// A DESTROY_RUNNER job is enqueued for this runner (it's inserted QUEUED; a live shared-DB
		// runner may then claim + fail it against the fake creds, so assert the job exists rather
		// than pin a transient status — we stop at "job was queued", per the authoring contract).
		await expect
			.poll(
				async () => {
					const rows = await db()<{ id: string }[]>`
						select id from jobs
						where cloud_identity_id = ${identity.id}
						  and job_type = 'DESTROY_RUNNER'
						  and config_snapshot->>'runner_id' = ${runner.id}`;
					return rows.length;
				},
				{ timeout: 15_000 },
			)
			.toBeGreaterThanOrEqual(1);
	});
});
