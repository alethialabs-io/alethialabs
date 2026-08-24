// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — the "insights" surfaces of the console, none of which need a real AI/runner round-trip:
//   • /${org}/~/agent   — the AI Agent chat shell: thread rail, Ask/Act segment + model picker
//                         (components/agent/*). We assert the surface LOADS and the pickers switch;
//                         we never send a message (no AI_GATEWAY_API_KEY in QA → sends 503).
//   • /${org}/~/usage   — components/settings/usage/usage-panel.tsx: plan & limits meters, resources,
//                         the over-time CSS bar chart + its time-range picker + metric tabs, AI usage.
//   • /${org}/~/settings/activity — components/settings/activity/*: the natural-language audit feed +
//                         the reusable filter bar (search, User/Project facets, the Events sheet).
//   • account menu → Settings dialog — components/shell/account-settings-dialog.tsx.
//
// Personas: `owner` = Hobby (community, free), `team` = Pro (card-less trialing). Gating / validation /
// empty-state paths live in agent-usage-activity.negative.spec.ts.

import { expect, test } from "../fixtures/qa";

const agentPath = (slug: string) => `/${slug}/~/agent`;
const usagePath = (slug: string) => `/${slug}/~/usage`;
const activityPath = (slug: string) => `/${slug}/~/settings/activity`;

// The QA console at :3100 is shared across parallel agents — GETs can spike under load. Give each
// test headroom so a slow render never masquerades as a real failure.
test.beforeEach(() => {
	test.setTimeout(120_000);
});

// ── Agent — chat surface ────────────────────────────────────────────────────────────────────
test.describe("Agent — chat surface (owner)", () => {
	test("authed persona reaches the agent (not bounced to /login)", async ({ owner }) => {
		await owner.page.goto(agentPath(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);
		// The thread rail's primary action anchors the shell.
		await expect(owner.page.getByRole("button", { name: /new chat/i })).toBeVisible({
			timeout: 30_000,
		});
	});

	test("chat top bar exposes the Ask/Act segment and the default model", async ({ owner }) => {
		await owner.page.goto(agentPath(owner.orgSlug));
		await expect(owner.page.getByRole("button", { name: "ask", exact: true })).toBeVisible({
			timeout: 30_000,
		});
		await expect(owner.page.getByRole("button", { name: "act", exact: true })).toBeVisible();
		// Index 0 of AI_MODELS (lib/config/ai.ts) is the default shown on the picker trigger.
		await expect(
			owner.page.getByRole("button", { name: /Claude Sonnet 4\.6/i }),
		).toBeVisible();
	});

	test("switching to Act marks the Act segment active", async ({ owner }) => {
		await owner.page.goto(agentPath(owner.orgSlug));
		const act = owner.page.getByRole("button", { name: "act", exact: true });
		await act.click();
		// Active mode gets the `bg-muted` treatment (chat-top-bar.tsx).
		await expect(act).toHaveClass(/bg-muted/);
	});

	test("model picker switches from Sonnet to Opus", async ({ owner }) => {
		await owner.page.goto(agentPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /Claude Sonnet 4\.6/i }).click();
		await owner.page.getByRole("menuitem", { name: /Claude Opus 4\.8/i }).click();
		// The trigger label now reflects the newly-selected model.
		await expect(
			owner.page.getByRole("button", { name: /Claude Opus 4\.8/i }),
		).toBeVisible();
	});

	test("a fresh chat shows the suggestion prompts and the composer", async ({ owner }) => {
		await owner.page.goto(agentPath(owner.orgSlug));
		// A brand-new thread is guaranteed empty → the suggestions render.
		await owner.page.getByRole("button", { name: /new chat/i }).click();
		await expect(owner.page.getByText("Are my connectors healthy?")).toBeVisible({
			timeout: 30_000,
		});
		await expect(
			owner.page.getByPlaceholder(/ask the agent, or describe what to build/i),
		).toBeVisible();
	});

	test("thread rail exposes a chat search box", async ({ owner }) => {
		await owner.page.goto(agentPath(owner.orgSlug));
		await expect(owner.page.getByPlaceholder(/search chats/i)).toBeVisible({
			timeout: 30_000,
		});
	});
});

// ── Usage — plan & limits, charts, ranges ───────────────────────────────────────────────────
test.describe("Usage — meters + over-time chart", () => {
	test("authed persona reaches usage (not bounced to /login)", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByText("Plan & limits")).toBeVisible({ timeout: 30_000 });
	});

	test("the taxonomy sections all render", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page.getByText("Plan & limits")).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByText("Resources")).toBeVisible();
		await expect(owner.page.getByText("Usage over time")).toBeVisible();
		await expect(owner.page.getByText("AI usage")).toBeVisible();
	});

	test("plan & limits shows the three point-in-time meters", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page.getByText("Seats")).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByText("Runner minutes").first()).toBeVisible();
		await expect(owner.page.getByText("Concurrency")).toBeVisible();
	});

	test("the cloud-spend disclaimer is surfaced", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(
			owner.page.getByText(/cloud-resource spend is billed separately/i),
		).toBeVisible({ timeout: 30_000 });
	});

	test("switching the quick range updates the over-time trigger label", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page.getByText("Usage over time")).toBeVisible({ timeout: 30_000 });
		await owner.page.getByRole("button", { name: /last 7 days/i }).click();
		// Pick a preset within the Hobby retention window (30d is the negative/gated case).
		await owner.page.getByRole("button", { name: "Last 14 days", exact: true }).click();
		await expect(
			owner.page.getByRole("button", { name: /last 14 days/i }),
		).toBeVisible();
	});

	test("the over-time metric tabs switch the active series", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		const jobsTab = owner.page.getByRole("button", { name: "Jobs", exact: true });
		await expect(jobsTab).toBeVisible({ timeout: 30_000 });
		await jobsTab.click();
		// Active tab gets the `bg-surface-muted` pill (usage-panel.tsx).
		await expect(jobsTab).toHaveClass(/bg-surface-muted/);
	});

	test("Hobby usage exposes the inline Upgrade to Pro CTA", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(
			owner.page.getByRole("button", { name: /upgrade to pro/i }).first(),
		).toBeVisible({ timeout: 30_000 });
	});
});

test.describe("Usage — Pro trial (team)", () => {
	test("Pro usage shows the plan name and Manage billing (no upgrade CTA)", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(team.page.getByText("Pro plan")).toBeVisible({ timeout: 30_000 });
		await expect(team.page.getByRole("link", { name: /manage billing/i })).toBeVisible();
	});

	test("Pro usage exposes the spend-control hard-cap toggle", async ({ team }) => {
		await team.page.goto(usagePath(team.orgSlug));
		await expect(
			team.page.getByText(/pause new jobs at my included minutes/i),
		).toBeVisible({ timeout: 30_000 });
	});
});

// ── Activity — feed + filter bar (org scope) ────────────────────────────────────────────────
test.describe("Activity — org feed (owner)", () => {
	test("authed persona reaches activity (not bounced to /login)", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(
			owner.page.getByPlaceholder(/search actor, action or resource/i),
		).toBeVisible({ timeout: 30_000 });
	});

	test("the reusable filter bar renders all facets", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		await expect(
			owner.page.getByPlaceholder(/search actor, action or resource/i),
		).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByRole("button", { name: /^user$/i })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /^project$/i })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /events/i })).toBeVisible();
	});

	test("the Events sheet opens with the event taxonomy + result group", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /events/i }).click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByText("Result", { exact: true })).toBeVisible();
		await expect(dialog.getByText("Denied", { exact: true })).toBeVisible();
		await expect(dialog.getByText("Allowed", { exact: true })).toBeVisible();
	});

	test("the quick-range filter is present on the feed", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		await expect(
			owner.page.getByRole("button", { name: /last 7 days/i }),
		).toBeVisible({ timeout: 30_000 });
	});
});

// ── Account settings dialog ─────────────────────────────────────────────────────────────────
test.describe("Account settings dialog (owner)", () => {
	test("opens from the account menu and shows the user email", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /account menu/i }).click();
		await owner.page.getByRole("button", { name: /account settings/i }).click();

		const dialog = owner.page.getByRole("dialog");
		await expect(
			dialog.getByRole("heading", { name: /account settings/i }),
		).toBeVisible({ timeout: 15_000 });
		await expect(dialog.getByText(owner.email)).toBeVisible();
	});

	test("the dialog exposes the profile fields, auth badge and danger zone", async ({ owner }) => {
		await owner.page.goto(usagePath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /account menu/i }).click();
		await owner.page.getByRole("button", { name: /account settings/i }).click();

		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByLabel(/display name/i)).toBeVisible({ timeout: 15_000 });
		// The email input is read-only (immutable after registration).
		await expect(dialog.getByLabel("Email", { exact: true })).toBeDisabled();
		await expect(
			dialog.getByRole("button", { name: /delete account/i }),
		).toBeVisible();
	});
});
