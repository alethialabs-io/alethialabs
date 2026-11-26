// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub — the happy paths, driven as the `team` (Pro) persona because the whole surface
// is behind the `alerting` entitlement. The Hobby upsell, the verification failure and the
// member denial live in alerts.negative.spec.ts.
//
// WHAT THIS FILE ASSERTS THAT THE PREVIOUS ONE DID NOT, and why each is a rule rather than a
// preference:
//
//   · The two empty states go through `@repo/ui/empty` (`data-slot="empty"`), and their titles
//     are real headings. `EmptyState` renders its title as a plain `<div>` unless the caller
//     passes `level`, so "converted to the shared component" and "still in the outline" are two
//     different facts, and only the second one is what a screen reader gets.
//   · A rail row is an `option`, not a `button`. The Channels detail renders a "Used by" PILL
//     per policy that routes here, carrying that policy's name — so before the role split, one
//     policy name matched both the rail row and the pill and every `getByRole("button")` for it
//     was a strict-mode violation. There is a test below whose ONLY job is that separation.
//   · The three filter stores are prefixed (`channel*`, `policy*`, `activity*`) because they
//     share one URL. Each is exercised through a deep link, which is the half of the console
//     filter standard a click cannot reach, and each asserts the facet-count invariant:
//     counts come from the UNFILTERED universe, so the option you just selected does not
//     vanish and the bar stays un-un-selectable.
//   · The destructive controls are opened, READ against apps/console/destructive-actions.yaml,
//     and — for the disable switches — CANCELLED, so the registry's claim about them is tested
//     rather than restated. BOTH switches are deliberately asymmetric and both are covered here:
//     the channel's `onToggle` and the policy's `onToggleEnabled` confirm only on the disabling
//     branch (`if (!next) set…Target(…); else applyEnabled(…, true)`), so each direction gets its
//     own test and a spec that expected one confirm would be wrong half the time.
//
// `mode: "default"` — THE FILE RUNS SEQUENTIALLY IN ONE WORKER. The config is `fullyParallel`,
// and this file's fixtures are ORG-WIDE: `cleanAlerts()` wipes every alerting row for the team
// org, so under full parallelism one describe's `beforeAll` deletes the rows another describe is
// mid-assertion on. That is the shape of most of the 16 recorded reds here. `default` and not
// `serial`: serial SKIPS every later test once one fails, and the ratchet refuses an unrecorded
// skip — a red would silently become sixteen.

import { test, expect } from "../fixtures/qa";
import type { Page } from "@playwright/test";
import {
	cleanAlerts,
	seedChannel,
	seedDelivery,
	seedRule,
} from "../helpers/seed-alerts";
import type { Owner } from "../helpers/seed";

test.describe.configure({ mode: "default" });

const ALERTS = (org: string) => `/${org}/~/alerts`;

/** The three stacked surfaces, by the section ids alerts-page.tsx anchors its sidebar to. */
const sections = (page: Page) => ({
	policies: page.locator("#policies"),
	channels: page.locator("#channels"),
	activity: page.locator("#activity"),
});

/**
 * A count pill anywhere in a section. #7489 removed the three that sat beside the section headings
 * (no count pills anywhere, no "N of M" prose), so every use of this asserts it is ABSENT — and
 * only after something in the same section has been asserted PRESENT, because an absence check
 * over a section that never rendered passes while measuring nothing.
 */
const countPill = (section: ReturnType<typeof sections>["channels"]) =>
	section.locator("[data-slot='count-pill']");

/**
 * The delivery ledger's data rows. The ledger draws no count (#7489), so the rows ARE the answer
 * to "how many deliveries does this view show". `DataTable` renders through `@repo/ui/table`,
 * whose body and rows carry `data-slot="table-body"` / `data-slot="table-row"`; the ledger is the
 * only table in `#activity`. `toHaveCount` retries, so it waits out a filter's refetch.
 */
const ledgerRows = (activity: ReturnType<typeof sections>["activity"]) =>
	activity.locator("[data-slot='table-body'] [data-slot='table-row']");

/**
 * Opens a section's facet popover and returns its option rows. A facet is a popover now (polish-wave
 * spec §3, #7738), not a row of chips: the options render in a portal OUTSIDE the section, so they
 * are read off the page — and each option's accessible name is `<label>, <count>`.
 */
async function openFacet(
	page: Page,
	section: ReturnType<typeof sections>["channels"],
	label: string,
): Promise<ReturnType<Page["getByRole"]>> {
	// Only the popover TRIGGER (`aria-haspopup="dialog"`, e2e/helpers/facet.ts): the ledger's
	// sortable "Status" column header is a button with the same name.
	await section
		.getByRole("button", { name: label, exact: true })
		.and(section.locator('[aria-haspopup="dialog"]'))
		.click();
	return page.getByRole("dialog").getByRole("option");
}

/** Opens the Alerts hub (optionally with filter params) and waits for the surface. */
async function gotoAlerts(page: Page, org: string, query = ""): Promise<void> {
	await page.goto(`${ALERTS(org)}${query}`);
	await expect(page).not.toHaveURL(/\/login/);
	await expect(
		page.getByRole("heading", { name: "Channels", exact: true }),
	).toBeVisible({ timeout: 15_000 });
}

test.describe("Alerts — the hub", () => {
	test("a Pro org gets all three surfaces as section headings", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		for (const name of ["Policies", "Channels", "Activity"]) {
			await expect(
				team.page.getByRole("heading", { name, exact: true }),
			).toBeVisible();
		}
	});

	// #7489 removed the three heading count pills (maintainer ruling: no count pills anywhere).
	// Each heading is asserted PRESENT before its pill is asserted absent.
	test("each section heading carries a Docs link and no count pill", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await expect(team.page.getByRole("link", { name: "Docs" })).toHaveCount(3);
		const s = sections(team.page);
		for (const section of [s.policies, s.channels, s.activity]) {
			const heading = section.locator("[data-slot='section-heading']");
			await expect(heading).toHaveCount(1);
			await expect(heading.getByRole("link", { name: "Docs" })).toBeVisible();
			await expect(countPill(section)).toHaveCount(0);
		}
	});

	test("an authenticated Pro user is never bounced to login", async ({ team }) => {
		await team.page.goto(ALERTS(team.orgSlug!));
		await expect(team.page).not.toHaveURL(/\/login/);
	});
});

test.describe("Alerts — empty states, through EmptyState", () => {
	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
	});

	test("channels: the shared EmptyState, its title in the outline, and the Add action", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { channels } = sections(team.page);
		await expect(channels.locator("[data-slot='empty']")).toBeVisible();
		await expect(
			channels.getByRole("heading", { name: "No channels yet", level: 3 }),
		).toBeVisible();
		await expect(
			channels.getByRole("button", { name: "Add channel" }),
		).toBeVisible();
	});

	test("policies: the shared EmptyState, its title in the outline, and the New action", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { policies } = sections(team.page);
		await expect(policies.locator("[data-slot='empty']")).toBeVisible();
		await expect(
			policies.getByRole("heading", { name: "No policies yet", level: 3 }),
		).toBeVisible();
		await expect(
			policies.getByRole("button", { name: "New policy" }),
		).toBeVisible();
	});

	// An empty universe used to read "0" in both heading pills; #7489 removed them, so the empty
	// state is the whole answer. The EmptyState is asserted first so the absence is not vacuous.
	test("an empty universe draws no count beside either heading, only the EmptyState", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const s = sections(team.page);
		for (const section of [s.channels, s.policies]) {
			await expect(section.locator("[data-slot='empty']")).toBeVisible();
			await expect(countPill(section)).toHaveCount(0);
		}
	});

	// #4968 (F10, #4939) moved the ledger's empty state from the table's muted row into the shared
	// EmptyState; with no filter on it says nothing has been delivered yet and offers no Reset.
	test("an empty ledger lands in the shared EmptyState, which says nothing was delivered yet", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { activity } = sections(team.page);
		await expect(activity.locator("[data-slot='empty']")).toBeVisible();
		await expect(activity.getByText("No activity yet")).toBeVisible();
		await expect(activity.getByRole("button", { name: "Clear filters" })).toHaveCount(0);
	});
});

test.describe("Alerts — the guided add-a-channel sheet", () => {
	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
	});

	/** Opens the sheet from the Channels section and returns it. */
	async function openSheet(page: Page, org: string) {
		await gotoAlerts(page, org);
		await sections(page).channels
			.getByRole("button", { name: "Add channel" })
			.first()
			.click();
		const sheet = page.getByRole("dialog", { name: "Add a channel" });
		await expect(sheet).toBeVisible();
		return sheet;
	}

	test("opens with the transport gallery", async ({ team }) => {
		const sheet = await openSheet(team.page, team.orgSlug!);
		await expect(sheet.getByText("Transport", { exact: true })).toBeVisible();
		await expect(
			sheet.getByRole("button", { name: "Email SES relay" }),
		).toBeVisible();
	});

	// The transport gallery drives which credential field the form renders — this test asserts the
	// FIELDS, and deliberately does not submit. Until #4456 it could not have: the `qa` leg set no
	// ALETHIA_CRED_ENCRYPTION_KEY, so a secret-bearing transport's "Add channel" was disabled and
	// the only reachable assertion was the fail-closed one. The leg now promises `encryption`, and
	// the submit paths that unlocked — the live button, and a webhook whose endpoint cannot be
	// verified — are asserted in alerts.negative.spec.ts, tagged `@needs:encryption`.
	//
	// This test stays a field-shape test because that is a different question, and because the
	// happy path it would otherwise need is a channel this file's describes do not clean up.
	test("picking a transport swaps the credential field", async ({ team }) => {
		const sheet = await openSheet(team.page, team.orgSlug!);
		await sheet.getByRole("button", { name: "Email SES relay" }).click();
		await expect(sheet.getByPlaceholder("name@acme.cloud")).toBeVisible();
		await sheet.getByRole("button", { name: "Webhook HTTPS POST" }).click();
		await expect(sheet.getByLabel("Payload URL", { exact: true })).toBeVisible();
		// `getByRole("textbox")`, not `getByLabel`: the FieldHelp trigger beside this field is a
		// button named "Help: Signing secret", and getByLabel matches a substring — so the label
		// alone resolves to the input AND its help popover trigger.
		await expect(
			sheet.getByRole("textbox", { name: "Signing secret" }),
		).toBeVisible();
	});

	test("email: a blank name is rejected inline", async ({ team }) => {
		const sheet = await openSheet(team.page, team.orgSlug!);
		await sheet.getByRole("button", { name: "Email SES relay" }).click();
		await sheet.getByLabel("Name", { exact: true }).fill("");
		const input = sheet.getByPlaceholder("name@acme.cloud");
		await input.fill("valid@e2e.test");
		await input.press("Enter");
		await sheet.getByRole("button", { name: "Add channel" }).click();
		await expect(sheet.getByText("Name your channel")).toBeVisible();
	});

	test("email: no recipients is rejected inline, before any server call", async ({
		team,
	}) => {
		const sheet = await openSheet(team.page, team.orgSlug!);
		await sheet.getByRole("button", { name: "Email SES relay" }).click();
		await sheet.getByRole("button", { name: "Add channel" }).click();
		await expect(sheet.getByText("Add at least one recipient.")).toBeVisible();
	});

	test("the recipients editor rejects a malformed address", async ({ team }) => {
		const sheet = await openSheet(team.page, team.orgSlug!);
		await sheet.getByRole("button", { name: "Email SES relay" }).click();
		const input = sheet.getByPlaceholder("name@acme.cloud");
		await input.fill("not-an-email");
		await input.press("Enter");
		await expect(sheet.getByText(/Not a valid email/)).toBeVisible();
	});

	test("email: the happy path creates a channel and it lands in the rail as an option", async ({
		team,
	}) => {
		const name = `e2e-email-${Date.now()}`;
		const sheet = await openSheet(team.page, team.orgSlug!);
		await sheet.getByRole("button", { name: "Email SES relay" }).click();
		await sheet.getByLabel("Name", { exact: true }).fill(name);
		const input = sheet.getByPlaceholder("name@acme.cloud");
		await input.fill("alerts@e2e.test");
		await input.press("Enter");
		await sheet.getByRole("button", { name: "Add channel" }).click();
		await expect(
			sections(team.page).channels.getByRole("option", { name }),
		).toBeVisible({ timeout: 20_000 });
	});
});

test.describe("Alerts — a channel's detail", () => {
	let channelName: string;
	let policyName: string;

	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
		const owner: Owner = { userId: team.userId!, orgId: team.orgId! };
		channelName = `e2e-detail-${Date.now()}`;
		const ch = await seedChannel(owner, {
			type: "email",
			name: channelName,
			recipients: ["ops@e2e.test"],
			verified: true,
		});
		policyName = `e2e-userof-${Date.now()}`;
		await seedRule(owner, {
			name: policyName,
			eventPatterns: ["system.job.failed"],
			enabled: true,
			channelIds: [ch.id],
		});
	});

	// The meta strip is asserted through its VALUES, not its labels. "Transport" is the label of
	// the Transport meta cell AND the label of the transport FacetFilter's trigger in the bar
	// three inches above it, so the bare word resolves to two nodes inside `#channels` — which is
	// worth stating, because #4270 says this label "is gone" and it is not: it is ambiguous.
	test("selecting a channel shows its Transport / Target / Used-by meta", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { channels } = sections(team.page);
		await channels.getByRole("option", { name: channelName }).click();
		await expect(channels.getByText("SES relay", { exact: true })).toBeVisible();
		await expect(channels.getByText("1 policy", { exact: true })).toBeVisible();
		await expect(channels.getByLabel("Channel name")).toHaveValue(channelName);
	});

	// THE ROLE SPLIT. One policy name is on screen twice — as a rail row in Policies and as a
	// "Used by" pill in the selected channel's detail — and before the rows became options the
	// two were both buttons, so any by-role reference to that name was ambiguous.
	test("a policy's rail row and its Used-by pill are told apart by role", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { channels, policies } = sections(team.page);
		await channels.getByRole("option", { name: channelName }).click();

		await expect(
			policies.getByRole("option", { name: policyName }),
		).toHaveCount(1);
		await expect(
			channels.getByRole("button", { name: policyName }),
		).toHaveCount(1);
		// Page-wide, the name resolves to exactly one option and exactly one button — which is
		// what makes a strict-mode locator for either of them legal at all.
		await expect(team.page.getByRole("option", { name: policyName })).toHaveCount(1);
		await expect(team.page.getByRole("button", { name: policyName })).toHaveCount(1);
	});

	// Every mutating test below seeds its OWN row rather than editing the describe's, so a failure
	// here cannot cascade into the next test through a name that moved.
	test("the name field is labelled, and editing it raises the dirty save bar", async ({
		team,
	}) => {
		const subject = `e2e-rename-${Date.now()}`;
		await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{ type: "email", name: subject, recipients: ["x@e2e.test"], verified: true },
		);
		await gotoAlerts(team.page, team.orgSlug!);
		const { channels } = sections(team.page);
		await channels.getByRole("option", { name: subject }).click();
		await channels.getByLabel("Channel name").fill(`${subject}-renamed`);
		await expect(channels.getByText("Unsaved changes")).toBeVisible();
		await channels.getByRole("button", { name: "Save changes" }).click();
		await expect(channels.getByText("Unsaved changes")).toBeHidden({
			timeout: 15_000,
		});
	});

	// registry: alerts.channel.disable — confirm: confirm-dialog, confirm_action "Disable".
	// Opened and CANCELLED: the point of the entry is that nothing mutates on a bare click.
	test("disabling asks for confirmation, and Cancel leaves the channel enabled", async ({
		team,
	}) => {
		const subject = `e2e-disable-${Date.now()}`;
		await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{ type: "email", name: subject, recipients: ["x@e2e.test"], verified: true },
		);
		await gotoAlerts(team.page, team.orgSlug!);
		const { channels } = sections(team.page);
		await channels.getByRole("option", { name: subject }).click();
		const toggle = channels.getByRole("switch", { name: "Enabled" });
		await expect(toggle).toBeChecked();

		await toggle.click();
		const dialog = team.page.getByRole("alertdialog");
		await expect(dialog.getByText("Disable this channel?")).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Disable" })).toBeVisible();

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toBeHidden();
		await expect(toggle).toBeChecked();
	});

	// The other half of the asymmetry, and the reason the registry entry describes ONE direction:
	// `onToggle` is `if (!next) setDisableConfirm(true); else applyEnabled(true)`, so ENABLING
	// mutates on a bare click by design. A spec that asserted a confirm for "the switch" would be
	// wrong half the time.
	test("enabling a paused channel fires with no confirmation", async ({ team }) => {
		const paused = `e2e-paused-${Date.now()}`;
		await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{ type: "email", name: paused, recipients: ["x@e2e.test"], enabled: false },
		);
		await gotoAlerts(team.page, team.orgSlug!);
		const { channels } = sections(team.page);
		await channels.getByRole("option", { name: paused }).click();
		const toggle = channels.getByRole("switch", { name: "Enabled" });
		await expect(toggle).not.toBeChecked();

		await toggle.click();
		await expect(toggle).toBeChecked({ timeout: 15_000 });
		await expect(team.page.getByRole("alertdialog")).toHaveCount(0);
	});

	// registry: alerts.channel.delete — confirm-dialog, dialog_title `Delete channel "<name>"?`.
	test("the delete confirm names the channel, and confirming removes it", async ({
		team,
	}) => {
		const doomed = `e2e-doomed-${Date.now()}`;
		await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{ type: "email", name: doomed, recipients: ["x@e2e.test"], verified: true },
		);
		await gotoAlerts(team.page, team.orgSlug!);
		const { channels } = sections(team.page);
		await channels.getByRole("option", { name: doomed }).click();
		await channels.getByRole("button", { name: "Delete channel" }).click();

		const dialog = team.page.getByRole("alertdialog");
		await expect(dialog.getByText(`Delete channel "${doomed}"?`)).toBeVisible();
		await dialog.getByRole("button", { name: "Delete channel" }).click();
		await expect(
			channels.getByRole("option", { name: doomed }),
		).toHaveCount(0, { timeout: 15_000 });
	});

	test("an unverified channel can be verified from its detail", async ({ team }) => {
		const pending = `e2e-verify-${Date.now()}`;
		await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{
				type: "email",
				name: pending,
				recipients: ["verify@e2e.test"],
				verified: false,
			},
		);
		await gotoAlerts(team.page, team.orgSlug!);
		const { channels } = sections(team.page);
		await channels.getByRole("option", { name: pending }).click();
		await channels.getByRole("button", { name: "Verify", exact: true }).click();
		await expect(
			channels.getByText("Verified — a sample event reached the endpoint."),
		).toBeVisible({ timeout: 20_000 });
	});
});

test.describe("Alerts — the channel filter store (channel*)", () => {
	let verifiedA: string;
	let pausedOne: string;

	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
		const owner: Owner = { userId: team.userId!, orgId: team.orgId! };
		const stamp = Date.now();
		verifiedA = `e2e-chfilter-a-${stamp}`;
		await seedChannel(owner, { type: "email", name: verifiedA, verified: true });
		await seedChannel(owner, {
			type: "email",
			name: `e2e-chfilter-b-${stamp}`,
			verified: true,
		});
		pausedOne = `e2e-chfilter-off-${stamp}`;
		await seedChannel(owner, {
			type: "email",
			name: pausedOne,
			verified: true,
			enabled: false,
		});
	});

	test("typing in the bar narrows the rail and writes `channel` to the URL", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { channels } = sections(team.page);
		await expect(channels.getByRole("option")).toHaveCount(3);
		await channels
			.getByRole("textbox", { name: "Filter channels by name or transport…", exact: true })
			.fill(verifiedA);
		await expect(channels.getByRole("option")).toHaveCount(1);
		await expect(team.page).toHaveURL(/[?&]channel=/, { timeout: 15_000 });
	});

	test("a `channelStatus` deep link arrives already filtered", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!, "?channelStatus=paused");
		const { channels } = sections(team.page);
		await expect(channels.getByRole("option")).toHaveCount(1);
		await expect(channels.getByRole("option", { name: pausedOne })).toBeVisible();
	});

	// The invariant the whole facet pass exists for: counts are tallied over the UNFILTERED
	// universe. Filter in memory and "Verified" would read 0 while "Paused" is selected — and a
	// facet whose only remaining option is the one you picked cannot be un-picked.
	test("facet counts stay over the unfiltered universe while a filter is on", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!, "?channelStatus=paused");
		const { channels } = sections(team.page);
		// The selected facet names its value on the trigger, with its own clear beside it.
		await expect(channels.getByRole("button", { name: "Clear Status", exact: true })).toBeVisible();
		const options = await openFacet(team.page, channels, "Status: Paused");
		// Exact names: "Verified" is a substring of "Unverified", so a text filter matches both.
		await expect(options.and(team.page.getByRole("option", { name: "Verified, 2", exact: true }))).toHaveCount(1);
		await expect(options.and(team.page.getByRole("option", { name: "Paused, 1", exact: true }))).toHaveCount(1);
	});

	// #4968 (F10, #4939): a filter that matches nothing lands in the shared EmptyState too, and that
	// state carries the way out — Clear filters (the shared `FilterEmpty`, #7738).
	test("a filter that matches nothing lands in the shared EmptyState, which offers Reset", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!, "?channel=zzz-no-such-channel");
		const { channels } = sections(team.page);
		await expect(channels.locator("[data-slot='empty']")).toBeVisible();
		await expect(channels.getByRole("button", { name: "Clear filters" })).toBeVisible();
		await expect(channels.getByRole("option")).toHaveCount(0);
		// The title says nothing matched without sizing the universe: #7489 removed the "None of
		// the N channels" copy with the pills. Exact, so a number creeping back reds here.
		await expect(
			channels.getByText("No channels match these filters.", { exact: true }),
		).toBeVisible();
	});
});

test.describe("Alerts — policies", () => {
	let channelName: string;

	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
		channelName = `e2e-pol-ch-${Date.now()}`;
		await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{ type: "email", name: channelName, recipients: ["ops@e2e.test"], verified: true },
		);
	});

	/** Opens the New-policy sheet from the Policies section and returns it. */
	async function openSheet(page: Page, org: string) {
		await gotoAlerts(page, org);
		await sections(page).policies
			.getByRole("button", { name: "New policy" })
			.first()
			.click();
		const sheet = page.getByRole("dialog", { name: "New alert policy" });
		await expect(sheet).toBeVisible();
		return sheet;
	}

	test("opens the New alert policy sheet", async ({ team }) => {
		const sheet = await openSheet(team.page, team.orgSlug!);
		await expect(sheet.getByLabel("Name", { exact: true })).toBeVisible();
	});

	test("submitting an empty sheet reports the missing name and events", async ({
		team,
	}) => {
		const sheet = await openSheet(team.page, team.orgSlug!);
		await sheet.getByRole("button", { name: "Create policy" }).click();
		await expect(sheet.getByText("Name your policy")).toBeVisible();
		await expect(sheet.getByText("Pick at least one event.")).toBeVisible();
	});

	test("security (PDP) events are locked without the advanced entitlement", async ({
		team,
	}) => {
		const sheet = await openSheet(team.page, team.orgSlug!);
		await sheet.getByRole("button", { name: /Policy \(PDP\)/ }).click();
		// The lock replaces the control outright: there is no switch to reach at all.
		await expect(
			sheet.getByRole("switch", { name: /authz\.\*\.\*\.denied/ }),
		).toHaveCount(0);
		await expect(sheet.getByText("Action denied")).toBeVisible();
	});

	test("the happy path creates a policy watching one event, routed to a channel", async ({
		team,
	}) => {
		const policyName = `e2e-policy-${Date.now()}`;
		const sheet = await openSheet(team.page, team.orgSlug!);
		await sheet.getByLabel("Name", { exact: true }).fill(policyName);

		await sheet.getByRole("button", { name: /Deploy & drift/ }).click();
		await sheet.getByRole("switch", { name: /system\.job\.failed/ }).click();

		await sheet.getByRole("button", { name: "Add channels" }).click();
		// The picker is a portalled popover, so its `option` rows are NOT the channels rail's.
		await team.page
			.locator("[data-slot='popover-content']")
			.getByRole("option", { name: channelName })
			.click();
		// Dismiss the picker by pressing inside the sheet but outside the popover. Escape would
		// also close it, but Escape is the SHEET's dismissal too, and which one consumes the key
		// is exactly the sort of thing that turns a test into a coin flip.
		await sheet
			.getByText("Watch a set of events and route them to your channels.")
			.click();
		// The binding landed, and the sheet is still open.
		await expect(
			sheet.getByRole("button", { name: `Remove ${channelName}` }),
		).toBeVisible();

		await sheet.getByRole("button", { name: "Create policy" }).click();
		await expect(
			sections(team.page).policies.getByRole("option", { name: policyName }),
		).toBeVisible({ timeout: 20_000 });
	});
});

test.describe("Alerts — a policy's detail", () => {
	let policyName: string;

	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
		const owner: Owner = { userId: team.userId!, orgId: team.orgId! };
		const ch = await seedChannel(owner, {
			type: "email",
			name: `e2e-edit-ch-${Date.now()}`,
			recipients: ["ops@e2e.test"],
			verified: true,
		});
		policyName = `e2e-edit-pol-${Date.now()}`;
		await seedRule(owner, {
			name: policyName,
			eventPatterns: ["system.job.failed"],
			enabled: true,
			channelIds: [ch.id],
		});
	});

	test("renders its Events / Routes to / Throttle meta", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { policies } = sections(team.page);
		await policies.getByRole("option", { name: policyName }).click();
		await expect(policies.getByText("Events", { exact: true })).toBeVisible();
		await expect(policies.getByText("Routes to", { exact: true })).toBeVisible();
		await expect(policies.getByText("Throttle", { exact: true })).toBeVisible();
	});

	// registry: alerts.policy.disable — confirm: confirm-dialog, confirm_action "Disable".
	// Opened and CANCELLED: the point of the entry is that nothing mutates on a bare click.
	// This test seeds its OWN row rather than editing the describe's, for the same reason the
	// channel twin does — a failure here cannot then cascade into the rename test below through
	// a policy whose enabled state moved.
	test("disabling asks for confirmation, and Cancel leaves the policy enabled", async ({
		team,
	}) => {
		const subject = `e2e-dis-pol-${Date.now()}`;
		await seedRule(
			{ userId: team.userId!, orgId: team.orgId! },
			{ name: subject, eventPatterns: ["system.job.failed"], enabled: true },
		);
		await gotoAlerts(team.page, team.orgSlug!);
		const { policies } = sections(team.page);
		await policies.getByRole("option", { name: subject }).click();
		const toggle = policies.getByRole("switch", { name: "Enabled" });
		await expect(toggle).toBeChecked();

		await toggle.click();
		const dialog = team.page.getByRole("alertdialog");
		await expect(dialog.getByText("Disable this policy?")).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Disable" })).toBeVisible();

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toBeHidden();
		await expect(toggle).toBeChecked();
	});

	// The other half of the asymmetry, exactly as for channels: `onToggleEnabled` is
	// `if (!next) setDisableTarget(p); else applyEnabled(p, true)`, so ENABLING mutates on a bare
	// click by design. A spec that asserted a confirm for "the switch" would be wrong half the time.
	test("enabling a paused policy fires with no confirmation", async ({ team }) => {
		const paused = `e2e-paused-pol-${Date.now()}`;
		await seedRule(
			{ userId: team.userId!, orgId: team.orgId! },
			{ name: paused, eventPatterns: ["system.job.failed"], enabled: false },
		);
		await gotoAlerts(team.page, team.orgSlug!);
		const { policies } = sections(team.page);
		await policies.getByRole("option", { name: paused }).click();
		const toggle = policies.getByRole("switch", { name: "Enabled" });
		await expect(toggle).not.toBeChecked();

		await toggle.click();
		await expect(toggle).toBeChecked({ timeout: 15_000 });
		await expect(team.page.getByRole("alertdialog")).toHaveCount(0);
	});

	test("editing renames it through the labelled name field", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { policies } = sections(team.page);
		await policies.getByRole("option", { name: policyName }).click();
		await policies.getByRole("button", { name: "Edit policy" }).click();
		const renamed = `${policyName}-v2`;
		await policies.getByLabel("Policy name").fill(renamed);
		await policies.getByRole("button", { name: "Save", exact: true }).click();
		await expect(
			policies.getByRole("option", { name: renamed }),
		).toBeVisible({ timeout: 20_000 });
	});

	// registry: alerts.policy.delete — confirm-dialog, dialog_title `Delete policy "<name>"?`.
	test("the delete confirm names the policy, and confirming removes it", async ({
		team,
	}) => {
		const doomed = `e2e-del-pol-${Date.now()}`;
		await seedRule(
			{ userId: team.userId!, orgId: team.orgId! },
			{ name: doomed, eventPatterns: ["system.job.failed"], enabled: true },
		);
		await gotoAlerts(team.page, team.orgSlug!);
		const { policies } = sections(team.page);
		await policies.getByRole("option", { name: doomed }).click();
		await policies.getByRole("button", { name: "Delete policy" }).click();

		const dialog = team.page.getByRole("alertdialog");
		await expect(dialog.getByText(`Delete policy "${doomed}"?`)).toBeVisible();
		await dialog.getByRole("button", { name: "Delete policy" }).click();
		await expect(
			policies.getByRole("option", { name: doomed }),
		).toHaveCount(0, { timeout: 15_000 });
	});
});

test.describe("Alerts — the policy filter store (policy*)", () => {
	let offPolicy: string;

	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
		const owner: Owner = { userId: team.userId!, orgId: team.orgId! };
		const stamp = Date.now();
		await seedRule(owner, { name: `e2e-polfilter-on-${stamp}`, enabled: true });
		await seedRule(owner, { name: `e2e-polfilter-on2-${stamp}`, enabled: true });
		offPolicy = `e2e-polfilter-off-${stamp}`;
		await seedRule(owner, { name: offPolicy, enabled: false });
	});

	test("a `policyStatus` deep link arrives already filtered", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!, "?policyStatus=off");
		const { policies } = sections(team.page);
		await expect(policies.getByRole("option")).toHaveCount(1);
		await expect(policies.getByRole("option", { name: offPolicy })).toBeVisible();
	});

	test("the status facet keeps its unfiltered counts while `off` is selected", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!, "?policyStatus=off");
		const { policies } = sections(team.page);
		const options = await openFacet(team.page, policies, "Status: Off");
		await expect(options.filter({ hasText: "Enabled" })).toHaveAccessibleName("Enabled, 2");
		await expect(options.filter({ hasText: "Off" })).toHaveAccessibleName("Off, 1");
	});

	test("the three stores are independent: a policy filter leaves the channel rail alone", async ({
		team,
	}) => {
		const channelName = `e2e-independent-${Date.now()}`;
		await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{ type: "email", name: channelName, verified: true },
		);
		await gotoAlerts(team.page, team.orgSlug!, "?policyStatus=off");
		const s = sections(team.page);
		// The policy rail is narrowed to the one paused policy; the channel rail, under its own
		// `channel*` store, still shows its whole (one-row) universe.
		await expect(s.policies.getByRole("option")).toHaveCount(1);
		await expect(s.policies.getByRole("option", { name: offPolicy })).toBeVisible();
		await expect(s.channels.getByRole("option")).toHaveCount(1);
		await expect(s.channels.getByRole("option", { name: channelName })).toBeVisible();
	});
});

test.describe("Alerts — the delivery ledger and its activity* filters", () => {
	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
		const owner: Owner = { userId: team.userId!, orgId: team.orgId! };
		await seedDelivery(owner, {
			status: "sent",
			title: "e2e delivered event",
			eventKey: "system.job.succeeded",
		});
		await seedDelivery(owner, {
			status: "failed",
			title: "e2e failed event",
			eventKey: "system.job.failed",
			attempts: 3,
			lastError: "endpoint returned 500",
		});
	});

	test("the ledger lists the seeded deliveries, one row each, and draws no count", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { activity } = sections(team.page);
		await expect(activity.getByText("e2e delivered event")).toBeVisible();
		await expect(activity.getByText("e2e failed event")).toBeVisible();
		await expect(ledgerRows(activity)).toHaveCount(2);
		await expect(countPill(activity)).toHaveCount(0);
	});

	test("a failed delivery carries its last error into the Event cell", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { activity } = sections(team.page);
		await expect(activity.getByText("endpoint returned 500")).toBeVisible();
	});

	test("the Failed chip narrows the ledger to failed deliveries", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const { activity } = sections(team.page);
		const options = await openFacet(team.page, activity, "Status");
		await options.filter({ hasText: "Failed" }).click();
		await team.page.keyboard.press("Escape");
		await expect(activity.getByRole("button", { name: "Status: Failed", exact: true })).toBeVisible();
		await expect(activity.getByText("e2e failed event")).toBeVisible();
		await expect(activity.getByText("e2e delivered event")).toBeHidden();
		await expect(ledgerRows(activity)).toHaveCount(1);
	});

	test("an `activityStatus` deep link arrives filtered, chips still unfiltered", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!, "?activityStatus=sent");
		const { activity } = sections(team.page);
		await expect(activity.getByText("e2e delivered event")).toBeVisible();
		await expect(activity.getByText("e2e failed event")).toBeHidden();
		await expect(ledgerRows(activity)).toHaveCount(1);
		// Both options keep their universe counts, so the selection can be undone.
		const options = await openFacet(team.page, activity, "Status: Sent");
		await expect(options.filter({ hasText: "Sent" })).toHaveAccessibleName("Sent, 1");
		await expect(options.filter({ hasText: "Failed" })).toHaveAccessibleName("Failed, 1");
	});

	test.afterAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
	});
});
