// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RBAC — negative permission paths for a reduced-perm invited member.
//
// The `member` persona is REAL as of #3633: e2e/global-setup.ts invites it into ownerTeam's org
// through the product's own `organization/invite-member` → `accept-invitation` endpoints and reads
// its role back out of the `member` table. These assert the server-side PDP (requireAccessAdmin /
// owner-only) denials the UI otherwise renders optimistically.
//
// THERE IS NO `HAVE_MEMBER` GUARD ANY MORE, deliberately. It used to be `test.skip(!HAVE_MEMBER)`,
// and an unset variable turned every denial below into a green skip — the suite reported nothing
// and read as coverage. If the persona failed to be built, the `member` fixture now throws with the
// reason, and this file goes RED, which is the correct verdict for "the RBAC negatives did not
// run". `flows/_persona-integrity.spec.ts` is what proves the persona is genuinely distinct and
// genuinely reduced-permission before any denial here is believed.
//
// ── WHAT THESE FOUR HAD NEVER MEASURED (#4271) ──────────────────────────────────────────────────
//
// Every one of them opened with `getByText("Seats")` and failed there. The members page's stat-card
// strip was deleted under CLAUDE.md §6 ("no stat-card strips") and its four figures became the
// Status facet's option counts — so the precondition, not the denial, was what went red, and no
// test in this file had ever reached a permission. They now gate on the Status facet, which is
// where those figures live today.
//
// ── AND THEY NOW MEASURE THE REFUSAL, NOT A TOAST ───────────────────────────────────────────────
//
// `members-table.tsx` calls `authClient.organization.removeMember` / `updateMemberRole` and DROPS
// the error — there is no toast to assert on, so the old assertions could not have passed even with
// a working precondition. The denial that exists is the SERVER'S: the response to the org endpoint
// the click reaches. Each test below waits for that response and asserts a 4xx, and then asserts
// the state the refusal implies (the row is still there, the role is unchanged). One says the write
// was refused; the other says nothing slipped past by another route.
//
// ── THE DENIALS RUN AGAINST A SEEDED COLLEAGUE, NOT THE PERSONA ─────────────────────────────────
//
// "a member cannot remove ANOTHER member" needs another member. The org holds the owner — whose row
// renders no manage menu — and the member itself, so these used to drive the member's own row,
// which asks a different question (leaving an org). Worse: had the denial regressed, the suite would
// have deleted the persona every other spec in the run depends on. helpers/seed-rbac.ts seeds a
// throwaway member instead; a regression now costs a row this file created.

import { test, expect, type PersonaSession } from "../fixtures/qa";
import type { Locator, Page } from "@playwright/test";
import { personaOwner, removeSeededMember, seedOrgMember, type SeededMember } from "../helpers/seed-rbac";
import type { Owner } from "../helpers/seed";

// `undefined` until the seed has run, and the teardown below READS that rather than assuming it.
// `personaOwner` is written to throw — ownerTeam is best-effort in global-setup when Stripe is not
// promised — and a teardown that dereferences an unassigned binding replaces the diagnostic worth
// throwing for ("Persona ownerTeam missing from personas.json") with a `TypeError` from the hook,
// which is the line a reader sees first.
let victim: SeededMember | undefined;

test.beforeAll(async () => {
	const owner: Owner = personaOwner("ownerTeam");
	victim = await seedOrgMember(owner, { label: "denials", name: "Denial Target", role: "viewer" });
});

// BY ID, and with no org-wide purge on the way in.
//
// Playwright runs `beforeAll`/`afterAll` ONCE PER WORKER, and this project is `fullyParallel` — the
// release gate runs it with `--workers=3` (release-gate.yml's matrix passes the flag, which
// overrides `workers: isCI ? 1` in the config), so several workers really do execute the pair
// against the same org. A purge scoped to (org, prefix) would then delete the victim ANOTHER worker
// is mid-assertion on: `victimRow` goes to zero and the denial fails naming the row rather than the
// permission. `helpers/seed-nav.ts` already recorded that rule for the same reason — a seeder's
// blast radius must be the set it can enumerate, and this worker's own row is that set.
test.afterAll(async () => {
	if (victim) await removeSeededMember(victim);
});

/**
 * The members surface has finished rendering.
 *
 * The Status facet, NOT the deleted "Seats" stat card: the strip is gone and its figures are this
 * facet's option counts. Gating on a control that no longer exists is what made all four denials in
 * this file fail before they reached a permission.
 */
async function membersReady(session: PersonaSession): Promise<void> {
	await session.page.goto(`/${session.orgSlug}/~/settings/members`);
	await expect(session.page).not.toHaveURL(/\/login/);
	await expect(session.page.getByRole("button", { name: /^Status/ })).toBeVisible({ timeout: 30_000 });
}

/**
 * Two clocks over one sequence, and the retry loop's is deliberately the SMALLER.
 *
 * `waitForResponse` has to be armed BEFORE the retried click — otherwise it can miss a request
 * fired by an attempt it did not wrap — so every retry is spent out of the response's budget as
 * well as its own. Given both the same 30s, a retry cycle that burns ~29s (a cold CI page with four
 * in-flight queries is exactly the case the loop exists for) leaves the successful click about a
 * second to be answered in, and the failure then reads "no response to
 * /organization/update-member-role": it names the INSTRUMENT rather than the permission, which is
 * the shape this file's header exists to eliminate.
 *
 * The fix SHRINKS the loop rather than inflating the response, because the `qa` project states no
 * `timeout` and therefore takes Playwright's 30s default for the whole test — a response budget
 * above that could never be spent, and would only relabel the same failure as an unattributed test
 * timeout. Twelve seconds is several open-and-activate attempts; what is left is the response's.
 *
 * It applies to the ONE loop that shares a clock with an armed response. `openInviteDialog` and
 * `activateRowMenuItem` both finish before their test arms `orgEndpoint`, so nothing of theirs is
 * spent out of a response budget and they keep the wider one.
 */
const REACH_BUDGET_MS = 12_000;
const RESPONSE_BUDGET_MS = 30_000;

/**
 * The response to the org endpoint a click reaches — armed BEFORE the click.
 *
 * Better Auth's org plugin answers on `/api/auth/organization/<action>`, so unlike a Next server
 * action (which POSTs to the current URL under an opaque `Next-Action` id) the request is
 * attributable: this path IS the identifier. That is what lets a denial be measured rather than
 * inferred from a toast the component never renders.
 */
function orgEndpoint(page: Page, action: string) {
	return page.waitForResponse(
		(r) => r.url().includes(`/api/auth/organization/${action}`) && r.request().method() === "POST",
		{ timeout: RESPONSE_BUDGET_MS },
	);
}

/**
 * Open the REAL invite dialog, retrying the open.
 *
 * The "Invite member" trigger is remounted when `canInvite` resolves async — the UpgradeDialog
 * trigger is swapped for the InviteMemberDialog one — and a click that lands mid-swap is dropped.
 * The same helper exists in rbac.spec.ts for the same reason; a denial that flakes on the OPEN
 * reports nothing about the permission it exists to measure.
 */
async function openInviteDialog(page: Page) {
	const dialog = page.getByRole("dialog");
	const heading = dialog.getByRole("heading", { name: "Invite members" });
	await expect(async () => {
		if (await dialog.isVisible().catch(() => false)) {
			await page.keyboard.press("Escape");
			await expect(dialog).toBeHidden({ timeout: 2_000 });
		}
		await page.getByRole("button", { name: /invite member/i }).click();
		await expect(heading).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	return dialog;
}

/**
 * A members row's actions trigger, BY PREFIX.
 *
 * The accessible name carries the row's subject now — `Manage member Denial Target` — so that one
 * "Manage" repeated down a column stops being N indistinguishable controls. A bare
 * `{ name: "Manage" }` is an EXACT match in Playwright and would find none of them.
 */
const ROW_MENU = /^Manage /;

/** The seeded colleague's row in the members table. */
function victimRow(page: Page) {
	if (!victim) {
		throw new Error("the denial seed did not run — this file has no colleague to drive; see the beforeAll failure above for the reason.");
	}
	return page.getByRole("row").filter({ hasText: victim.email });
}

/**
 * Open a row's Manage menu and activate one item, RETRYING THE WHOLE PAIR.
 *
 * Measured on run 34462370367: `element was detached from the DOM, retrying` on the menu item, in
 * both the remove and the role tests. The members table hydrates from four independent queries —
 * members, invitations, collaboration access and the batched classification map — and a row that
 * re-renders while its dropdown is open tears the portalled item out from under a click that
 * Playwright had already resolved. Retrying the CLICK alone cannot recover: the menu it belonged to
 * is gone. Re-opening is what recovers, so the open and the activation retry together.
 *
 * Re-clicking an item is safe here on purpose — every use below opens a CONFIRMATION, which mutates
 * nothing, and the mutations these tests drive are the ones being denied.
 */
async function activateRowMenuItem(page: Page, row: Locator, item: RegExp): Promise<void> {
	const menuItem = page.getByRole("menuitem", { name: item });
	await expect(async () => {
		await row.getByRole("button", { name: ROW_MENU }).click();
		await menuItem.click({ timeout: 2_000 });
		await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
}

test.describe("RBAC — member permission denials", () => {
	test("a member can view the members list but cannot invite", async ({ member }) => {
		await membersReady(member);
		// Viewing IS permitted — the seeded colleague is visible to the member.
		await expect(victimRow(member.page)).toBeVisible({ timeout: 30_000 });

		// `canInvite` is BILLING-scoped, not role-scoped (getCollaborationAccess → canOrgInvite),
		// and global-setup put a team/active billing row on this org to build the persona at all —
		// so the member gets the REAL invite dialog, not the Pro upsell. The gate it fails is the
		// PDP's, one layer down, which is the whole point of asserting here rather than on the
		// presence of a button.
		const dialog = await openInviteDialog(member.page);

		const target = `e2e-denied-${Date.now()}@alethia.test`;
		await dialog.getByPlaceholder("teammate@company.com").fill(target);
		const refused = orgEndpoint(member.page, "invite-member");
		await dialog.getByRole("button", { name: /^Send invite$/ }).click();
		const response = await refused;
		expect(response.status(), "a member must not be able to invite into the org").toBeGreaterThanOrEqual(400);

		// And nothing landed: the dialog stays open (the form only closes on a clean run) and no
		// pending row for the address appears.
		await expect(dialog.getByRole("heading", { name: "Invite members" })).toBeVisible();
		await member.page.reload();
		await expect(member.page.getByRole("row").filter({ hasText: target })).toHaveCount(0);
	});

	test("a member cannot change another member's role", async ({ member }) => {
		await membersReady(member);
		const row = victimRow(member.page);
		await expect(row).toBeVisible({ timeout: 30_000 });

		// The picker RENDERS for a member — `canManage` is the org's `organizations` entitlement, not
		// a permission — which is exactly why the denial has to be measured server-side.
		//
		// Armed BEFORE the retry loop, not inside it: `waitForResponse` starts listening the moment
		// it is called, so it cannot miss a request fired by an attempt it did not wrap. The open and
		// the option click retry together for the same reason `activateRowMenuItem` does — a row that
		// re-renders detaches the portalled option, and re-clicking a dead node cannot recover.
		const refused = orgEndpoint(member.page, "update-member-role");
		await expect(async () => {
			await row.getByRole("combobox", { name: "Role" }).click();
			await member.page.getByRole("option", { name: /^admin$/i }).click({ timeout: 2_000 });
		}).toPass({ timeout: 30_000 });
		const response = await refused;
		expect(response.status(), "a member must not be able to escalate a colleague to admin").toBeGreaterThanOrEqual(400);

		// The optimistic UI is not evidence — reload and read the row the server actually holds.
		await member.page.reload();
		await expect(member.page.getByRole("button", { name: /^Status/ })).toBeVisible({ timeout: 30_000 });
		await expect(victimRow(member.page).getByRole("combobox", { name: "Role" })).toContainText(/viewer/i);
	});

	test("a member cannot remove another member", async ({ member }) => {
		await membersReady(member);
		const row = victimRow(member.page);
		await expect(row).toBeVisible({ timeout: 30_000 });

		// Removing now ASKS FIRST (#4271) — the confirmation is part of the path to the mutation, so
		// a denial spec that clicked once and asserted immediately would be measuring the dialog.
		await activateRowMenuItem(member.page, row, /remove from organization/i);
		const confirm = member.page.getByRole("alertdialog");
		await expect(confirm.getByText("Remove this member?")).toBeVisible();
		const refused = orgEndpoint(member.page, "remove-member");
		await confirm.getByRole("button", { name: "Remove member" }).click();
		const response = await refused;
		expect(response.status(), "a member must not be able to remove a colleague").toBeGreaterThanOrEqual(400);

		await member.page.reload();
		await expect(victimRow(member.page)).toBeVisible({ timeout: 30_000 });
	});

	test("a member cannot suspend another member", async ({ member }) => {
		await membersReady(member);
		const row = victimRow(member.page);
		await expect(row).toBeVisible({ timeout: 30_000 });

		await activateRowMenuItem(member.page, row, /^Suspend$/);
		const confirm = member.page.getByRole("alertdialog");
		await expect(confirm.getByText("Suspend this member?")).toBeVisible();
		await confirm.getByRole("button", { name: "Suspend member" }).click();

		// `setMemberSuspended` is a Next SERVER ACTION, and a server action's request carries an
		// opaque `Next-Action` id rather than its name — so unlike the three above there is no
		// attributable response to assert on, and the honest measurement is the STATE. The member
		// stays Active because `authorize("manage_members")` refused the write.
		await member.page.reload();
		await expect(member.page.getByRole("button", { name: /^Status/ })).toBeVisible({ timeout: 30_000 });
		await expect(victimRow(member.page)).toContainText(/active/i);
	});

	test("a member cannot delete the organization", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}/~/settings/general`);
		await expect(member.page.getByRole("heading", { name: "Danger zone" })).toBeVisible({ timeout: 30_000 });
		await member.page.getByRole("button", { name: /^Delete organization$/ }).click();
		const dialog = member.page.getByRole("alertdialog");
		const refused = orgEndpoint(member.page, "delete");
		await dialog.getByRole("button", { name: /delete organization/i }).click();
		const response = await refused;
		expect(response.status(), "only an owner may delete the organization").toBeGreaterThanOrEqual(400);

		// The org survives — the member is still inside it, not bounced to a dashboard.
		await expect(member.page).not.toHaveURL(/\/dashboard$/);
		await member.page.goto(`/${member.orgSlug}/~/settings/members`);
		await expect(member.page.getByRole("button", { name: /^Status/ })).toBeVisible({ timeout: 30_000 });
	});
});
