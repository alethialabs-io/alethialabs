// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Org switch — the first paint after a CLIENT-SIDE org switch shows nothing of the org being left
// (#6113, ADR 0005 stress test R1).
//
// WHY THIS IS A BROWSER TEST. The read router's query keys (`[path, { input, type }]`) carry no
// org, so the only thing between org A's cached jobs and org B's jobs page is that the browser keeps
// ONE QueryClient PER ORG SEGMENT (`lib/query/client.ts`) and sends each read to the org the URL is
// on (`lib/rpc/client.ts`). A single browser-wide client would paint A's rows under B's address on
// the first frame after a soft navigation, then correct itself — no server test can see that,
// because the server never served the wrong rows. The integration proof of the SERVER half is
// `tests/integration/rpc-tenancy.*.test.ts`.
//
// ⚠ WHAT THIS SPEC DOES NOT PROVE (measured, #6113 review advisory 5). It does NOT, today, catch a
// broken per-org cache. With `getQueryClient` ignoring its scope — ONE browser client for every org —
// it stayed GREEN in two release-gate qa runs on a throwaway mutation branch (runs 39418376795 and
// 39421132139), the second with the record-reading observer below. The cached team query exists
// under the same key and `HydrationBoundary` hydrates an EXISTING query only in an effect, so a
// stale first render was expected; none reached the DOM, and why was not established (no runtime
// to debug it on). What it does prove: after a real client-side switch, no node carrying the
// previous org's job is ever inserted on the way to, or on, the new org's jobs page. The per-org
// cache itself is held by `tests/lib/query/query-client-scope.test.ts`, which the same mutation
// turns red (2 of 10), not by this file.
//
// THE FIXTURE. The `member` persona is the two-org user the suite already builds: it signs up with
// its own Hobby org, then is invited into `ownerTeam`'s org (global-setup.ts). Its record names the
// TEAM org; its own org is read from the database. The team marker job is authored by the TEAM
// OWNER, not the member: the jobs RLS policy has an owner arm, so a member-authored row would be
// visible in every org the member opens and could not tell a cache leak from a policy answer.
//
// WHAT "FIRST PAINT" MEANS HERE. A MutationObserver armed once the switch has landed records whether
// a node carrying the team marker is ever INSERTED afterwards — so a render that showed it and was
// then replaced still fails, even within one task, which a final-state assertion alone would miss.
// See `watchFor` for why it reads the mutation records rather than the page.

import type { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "../fixtures/qa";
import { db } from "../helpers/db";
import { seedJob, seedProject } from "../helpers/seed";
import { waitForShell } from "../helpers/shell";

/** The window flag the observer sets when the previous org's marker becomes visible. */
const SAW_PREVIOUS = "__alethiaSawPreviousOrg";

/** `ownerTeam.userId` from the persona record global-setup wrote (fixtures are not available in beforeAll). */
function teamOwnerUserId(): string {
	const meta: unknown = JSON.parse(
		fs.readFileSync(path.resolve(process.cwd(), "e2e/.auth/personas.json"), "utf8"),
	);
	const team = typeof meta === "object" && meta !== null && "ownerTeam" in meta ? meta.ownerTeam : null;
	const userId = typeof team === "object" && team !== null && "userId" in team ? team.userId : null;
	if (typeof userId !== "string") throw new Error("personas.json has no ownerTeam.userId — global-setup did not build the team persona");
	return userId;
}

/** The member's OWN org: the one it is in besides the team org it was invited into. */
async function ownOrgOf(userId: string, teamOrgId: string): Promise<{ id: string; slug: string; name: string }> {
	const rows = await db()<{ id: string; slug: string; name: string }[]>`
		select o.id, o.slug, o.name from member m join organization o on o.id = m.organization_id
		where m.user_id = ${userId} and o.id <> ${teamOrgId} and o.slug is not null and m.status = 'active'
		order by m.created_at asc limit 1`;
	const own = rows[0];
	if (!own) throw new Error(`the member persona (${userId}) has no org besides ${teamOrgId} — it is not a two-org user`);
	return own;
}

/**
 * Arms an observer that flags any later INSERTION of `marker` into the document.
 *
 * It reads each mutation RECORD's added nodes, not the document after the fact. A MutationObserver
 * callback runs as a microtask, and React can commit the stale rows and replace them (the hydration
 * effect) inside one task — so a callback that re-reads the page sees only the final state and
 * misses the stale render entirely. That is exactly what the first version of this spec did: with
 * one QueryClient shared across orgs it stayed GREEN (#6113 review, advisory 5). An added node keeps
 * its text after it is removed, so a stale row is caught even if it never survives to a paint —
 * which makes this stricter than "painted", deliberately.
 */
async function watchFor(page: Page, marker: string): Promise<void> {
	await page.evaluate(
		({ marker, flag }) => {
			Reflect.set(window, flag, false);
			const hit = (text: string | null) => {
				if (text?.includes(marker)) Reflect.set(window, flag, true);
			};
			new MutationObserver((records) => {
				for (const record of records) {
					record.addedNodes.forEach((node) => hit(node.textContent));
					if (record.type === "characterData") hit(record.target.textContent);
				}
			}).observe(document.body, { childList: true, subtree: true, characterData: true });
			hit(document.body.innerText);
		},
		{ marker, flag: SAW_PREVIOUS },
	);
}

test.describe("Org switch — the first paint shows no row from the previous org", () => {
	test.beforeEach(() => {
		test.setTimeout(180_000);
	});

	test("switching from the team org to the member's own org, then opening Jobs, never paints a team job", async ({ member }) => {
		if (!member.orgId || !member.userId) throw new Error("the member persona record has no orgId/userId");
		const stamp = Date.now();
		const own = await ownOrgOf(member.userId, member.orgId);

		const teamName = `e2e-orgswitch-team-${stamp}`;
		const ownName = `e2e-orgswitch-own-${stamp}`;
		const teamOwner = { userId: teamOwnerUserId(), orgId: member.orgId };
		const teamProject = await seedProject(teamOwner, { name: teamName });
		await seedJob(teamOwner, { projectId: teamProject.projectId, envId: teamProject.envId });
		const ownOwner = { userId: member.userId, orgId: own.id };
		const ownProject = await seedProject(ownOwner, { name: ownName });
		await seedJob(ownOwner, { projectId: ownProject.projectId, envId: ownProject.envId });

		// 1. The team org's jobs page shows the team job — the control: the marker is findable at all,
		//    and the team org's QueryClient now holds it.
		const page = member.page;
		await page.goto(`/${member.orgSlug}/~/jobs`);
		await expect(page).not.toHaveURL(/\/login/);
		await expect(page.getByText(teamName).first()).toBeVisible({ timeout: 30_000 });

		// 2. Switch org CLIENT-SIDE through the shell's own switcher (a `router.push`, no reload).
		await waitForShell(page);
		await page.getByRole("button", { name: "Switch organization" }).click();
		await page.getByRole("option", { name: own.name }).click();
		await page.waitForURL(new RegExp(`/${own.slug}(\\?|$)`), { timeout: 30_000 });
		await expect(page.getByText(teamName)).toHaveCount(0, { timeout: 15_000 });
		await watchFor(page, teamName);

		// 3. Open Jobs from the sidebar — a soft navigation in the same document, so a browser-wide
		//    cache would still be holding the team rows under the same query key.
		await page.locator(`a[href="/${own.slug}/~/jobs"]`).first().click();
		await page.waitForURL(new RegExp(`/${own.slug}/~/jobs`), { timeout: 30_000 });
		await expect(page.getByText(ownName).first()).toBeVisible({ timeout: 30_000 });

		await expect(page.getByText(teamName)).toHaveCount(0);
		expect(await page.evaluate((flag) => Reflect.get(window, flag), SAW_PREVIOUS), "a team job was painted after the switch").toBe(false);
	});
});
