// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts hub — happy paths + inline validation for notification channels (CRUD + verify),
// alert policies (CRUD + toggle) and the delivery activity ledger. All run as the `team`
// (Pro) persona, since the whole surface is gated behind the `alerting` entitlement (Pro+);
// the Hobby-upsell + error paths live in alerts.negative.spec.ts.
//
// Isolation: the alerting tables are only touched by this domain, so cleanAlerts() on the
// team org gives a deterministic baseline without wiping sibling agents' projects/jobs.

import { test, expect } from "../fixtures/qa";
import {
	cleanAlerts,
	seedChannel,
	seedDelivery,
	seedRule,
} from "../helpers/seed-alerts";
import type { Owner } from "../helpers/seed";

const ALERTS = (org: string) => `/${org}/~/alerts`;

/** Opens the Alerts page and waits for the three section headers to render. */
async function gotoAlerts(page: import("@playwright/test").Page, org: string) {
	await page.goto(ALERTS(org));
	await expect(page).not.toHaveURL(/\/login/);
	await expect(
		page.getByRole("heading", { name: "Channels", exact: true }),
	).toBeVisible({ timeout: 15_000 });
}

test.describe("Alerts — surface", () => {
	test("team (Pro) sees the live alerting surface with all three sections", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await expect(
			team.page.getByRole("heading", { name: "Policies", exact: true }),
		).toBeVisible();
		await expect(
			team.page.getByRole("heading", { name: "Channels", exact: true }),
		).toBeVisible();
		await expect(
			team.page.getByRole("heading", { name: "Activity", exact: true }),
		).toBeVisible();
	});

	test("each section header exposes a Docs link", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		const docs = team.page.getByRole("link", { name: "Docs" });
		await expect(docs).toHaveCount(3);
	});

	test("does not redirect an authenticated Pro user to login", async ({ team }) => {
		await team.page.goto(ALERTS(team.orgSlug!));
		await expect(team.page).not.toHaveURL(/\/login/);
	});
});

test.describe("Alerts — channels empty state", () => {
	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
	});

	test("shows the no-channels empty state with an Add channel action", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await expect(
			team.page.getByRole("heading", { name: "No channels yet" }),
		).toBeVisible();
		await expect(
			team.page.getByRole("button", { name: "Add channel" }),
		).toBeVisible();
	});

	test("shows the no-policies empty state with a New policy action", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await expect(
			team.page.getByRole("heading", { name: "No policies yet" }),
		).toBeVisible();
		await expect(
			team.page.getByRole("button", { name: "New policy" }),
		).toBeVisible();
	});
});

test.describe("Alerts — add channel sheet", () => {
	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
	});

	test("opens the guided Add-a-channel sheet", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: "Add channel" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await expect(sheet.getByText("Add a channel")).toBeVisible();
		await expect(sheet.getByText("Transport")).toBeVisible();
	});

	test("email channel: empty recipients is rejected inline (no server call)", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: "Add channel" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await sheet.getByRole("button", { name: /Email/ }).click();
		await sheet.getByRole("button", { name: "Add channel" }).click();
		await expect(
			sheet.getByText("Add at least one recipient."),
		).toBeVisible();
	});

	test("email channel: a blank name is rejected inline", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: "Add channel" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await sheet.getByRole("button", { name: /Email/ }).click();
		await sheet.getByLabel("Name", { exact: true }).fill("");
		await sheet.getByPlaceholder("name@acme.cloud").fill("valid@e2e.test");
		await sheet.getByPlaceholder("name@acme.cloud").press("Enter");
		await sheet.getByRole("button", { name: "Add channel" }).click();
		await expect(sheet.getByText("Name your channel")).toBeVisible();
	});

	test("recipients editor rejects an invalid email address", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: "Add channel" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await sheet.getByRole("button", { name: /Email/ }).click();
		const input = sheet.getByPlaceholder("name@acme.cloud");
		await input.fill("not-an-email");
		await input.press("Enter");
		await expect(sheet.getByText(/Not a valid email/)).toBeVisible();
	});

	test("webhook: a syntactically invalid URL is rejected before verifying", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: "Add channel" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await sheet.getByRole("button", { name: /^Webhook/ }).click();
		await sheet.getByLabel("Payload URL", { exact: true }).fill("not a url");
		await sheet.getByRole("button", { name: "Add channel" }).click();
		await expect(sheet.getByText("Enter a valid URL.")).toBeVisible();
	});

	test("email channel: happy path creates a verified channel", async ({ team }) => {
		const name = `e2e-email-${Date.now()}`;
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: "Add channel" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await sheet.getByRole("button", { name: /Email/ }).click();
		await sheet.getByLabel("Name", { exact: true }).fill(name);
		const input = sheet.getByPlaceholder("name@acme.cloud");
		await input.fill("alerts@e2e.test");
		await input.press("Enter");
		await sheet.getByRole("button", { name: "Add channel" }).click();
		// Sheet closes and the new channel appears in the rail.
		await expect(team.page.getByText(name)).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Alerts — channel detail, edit, toggle, delete", () => {
	let channelName: string;

	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
		channelName = `e2e-detail-${Date.now()}`;
		await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{ type: "email", name: channelName, recipients: ["ops@e2e.test"], verified: true },
		);
	});

	test("selecting a channel shows its detail with transport + target meta", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: new RegExp(channelName) }).click();
		await expect(team.page.getByText("Transport")).toBeVisible();
		await expect(team.page.getByText("SES relay").first()).toBeVisible();
		await expect(team.page.getByText("Verified").first()).toBeVisible();
	});

	test("search filters the channel rail (no match shows a message)", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page
			.getByPlaceholder("Search channels")
			.fill(`zzz-no-such-${Date.now()}`);
		await expect(team.page.getByText("No channels match.")).toBeVisible();
	});

	test("renaming a channel surfaces the dirty save bar and saves", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: new RegExp(channelName) }).click();
		const renamed = `${channelName}-renamed`;
		// The detail header name input holds the current channel name. (`getByDisplayValue` is a
		// Testing Library API and has never existed on Playwright's Page — match on the value.)
		await team.page.locator(`input[value="${channelName}"]`).fill(renamed);
		await expect(team.page.getByText("Unsaved changes")).toBeVisible();
		await team.page.getByRole("button", { name: "Save changes" }).click();
		await expect(team.page.getByText("Unsaved changes")).toBeHidden({
			timeout: 10_000,
		});
	});

	test("disabling a channel asks for confirmation", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page
			.getByRole("button", { name: new RegExp(channelName) })
			.first()
			.click();
		await team.page.locator("#channels").getByRole("switch").click();
		await expect(
			team.page.getByRole("alertdialog").getByText("Disable this channel?"),
		).toBeVisible();
	});

	test("deleting a channel confirms then removes it", async ({ team }) => {
		const doomed = `e2e-doomed-${Date.now()}`;
		await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{ type: "email", name: doomed, recipients: ["x@e2e.test"], verified: true },
		);
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: new RegExp(doomed) }).click();
		await team.page.getByRole("button", { name: "Delete channel" }).click();
		const dialog = team.page.getByRole("alertdialog");
		await expect(dialog.getByText(new RegExp(`Delete channel`))).toBeVisible();
		await dialog.getByRole("button", { name: "Delete channel" }).click();
		await expect(team.page.getByText(doomed)).toBeHidden({ timeout: 10_000 });
	});
});

test.describe("Alerts — channel verification", () => {
	let channelName: string;

	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
		channelName = `e2e-verify-${Date.now()}`;
		await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{ type: "email", name: channelName, recipients: ["verify@e2e.test"], verified: false },
		);
	});

	test("re-verifying an email channel succeeds (SES-off logs the sample)", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: new RegExp(channelName) }).click();
		await team.page
			.locator("#channels")
			.getByRole("button", { name: /^Verify$/ })
			.click();
		await expect(
			team.page.getByText("Verified — a sample event reached the endpoint."),
		).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Alerts — policies CRUD", () => {
	let channelName: string;
	let channelId: string;

	test.beforeAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
		channelName = `e2e-pol-ch-${Date.now()}`;
		const ch = await seedChannel(
			{ userId: team.userId!, orgId: team.orgId! },
			{ type: "email", name: channelName, recipients: ["ops@e2e.test"], verified: true },
		);
		channelId = ch.id;
	});

	test("opens the New alert policy sheet", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: "New policy" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await expect(sheet.getByText("New alert policy")).toBeVisible();
	});

	test("policy sheet validates required name + events on submit", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: "New policy" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await sheet.getByRole("button", { name: "Create policy" }).click();
		await expect(sheet.getByText("Name your policy")).toBeVisible();
		await expect(sheet.getByText("Pick at least one event.")).toBeVisible();
	});

	test("security (PDP) events are locked without the advanced entitlement", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: "New policy" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await sheet.getByRole("button", { name: /Policy \(PDP\)/ }).click();
		await expect(sheet.getByText("Ent").first()).toBeVisible();
	});

	test("happy path: create a policy watching one event routed to a channel", async ({
		team,
	}) => {
		const policyName = `e2e-policy-${Date.now()}`;
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: "New policy" }).first().click();
		const sheet = team.page.getByRole("dialog");
		await sheet.getByLabel("Name", { exact: true }).fill(policyName);

		// Pick an operational event.
		await sheet.getByRole("button", { name: /Deploy & drift/ }).click();
		await sheet
			.locator("div.grid")
			.filter({ hasText: "system.job.failed" })
			.getByRole("switch")
			.click();

		// Bind the seeded channel via the facet picker.
		await sheet.getByRole("button", { name: /Add channels/ }).click();
		await team.page.getByRole("option", { name: new RegExp(channelName) }).click();
		await team.page.keyboard.press("Escape");

		await sheet.getByRole("button", { name: "Create policy" }).click();
		await expect(team.page.getByText(policyName)).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Alerts — policy edit, toggle, delete", () => {
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

	test("policy detail renders its events / routes / throttle meta", async ({
		team,
	}) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: new RegExp(policyName) }).click();
		await expect(team.page.getByText("Events", { exact: true })).toBeVisible();
		await expect(team.page.getByText("Routes to")).toBeVisible();
		await expect(team.page.getByText("Throttle")).toBeVisible();
	});

	test("toggling the enable switch disables the policy", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: new RegExp(policyName) }).click();
		const toggle = team.page.locator("#policies").getByRole("switch").first();
		await expect(toggle).toBeChecked();
		await toggle.click();
		await expect(toggle).not.toBeChecked({ timeout: 10_000 });
	});

	test("editing a policy name saves it", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: new RegExp(policyName) }).click();
		await team.page.getByRole("button", { name: "Edit policy" }).click();
		const renamed = `${policyName}-v2`;
		await team.page.getByPlaceholder("Policy name").fill(renamed);
		await team.page.getByRole("button", { name: "Save", exact: true }).click();
		await expect(team.page.getByText(renamed).first()).toBeVisible({
			timeout: 15_000,
		});
	});

	test("deleting a policy confirms then removes it", async ({ team }) => {
		const owner: Owner = { userId: team.userId!, orgId: team.orgId! };
		const doomed = `e2e-del-pol-${Date.now()}`;
		await seedRule(owner, { name: doomed, eventPatterns: ["system.job.failed"], enabled: true });
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page.getByRole("button", { name: new RegExp(doomed) }).click();
		await team.page.getByRole("button", { name: "Delete policy" }).click();
		const dialog = team.page.getByRole("alertdialog");
		await dialog.getByRole("button", { name: "Delete policy" }).click();
		await expect(team.page.getByText(doomed)).toBeHidden({ timeout: 10_000 });
	});
});

test.describe("Alerts — delivery activity", () => {
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

	test("activity table lists seeded deliveries with a count", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await expect(team.page.getByText("e2e delivered event")).toBeVisible();
		await expect(team.page.getByText("e2e failed event")).toBeVisible();
		await expect(team.page.getByText(/2 of 2 events/)).toBeVisible();
	});

	test("the failed filter narrows to failed deliveries only", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page
			.locator("#activity")
			.getByRole("button", { name: "failed" })
			.click();
		await expect(team.page.getByText("e2e failed event")).toBeVisible();
		await expect(team.page.getByText("e2e delivered event")).toBeHidden();
		await expect(team.page.getByText(/1 of 2 events/)).toBeVisible();
	});

	test("the delivered filter narrows to sent deliveries only", async ({ team }) => {
		await gotoAlerts(team.page, team.orgSlug!);
		await team.page
			.locator("#activity")
			.getByRole("button", { name: "delivered" })
			.click();
		await expect(team.page.getByText("e2e delivered event")).toBeVisible();
		await expect(team.page.getByText("e2e failed event")).toBeHidden();
	});

	test.afterAll(async ({ team }) => {
		await cleanAlerts(team.orgId!);
	});
});
