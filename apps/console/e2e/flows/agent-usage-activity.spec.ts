// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — the "insights" surfaces of the console, none of which need a real AI/runner round-trip:
//   • the AGENT, reached from the topbar "Ask AI" control (components/shell/ask-ai-button.tsx →
//     the Elench docked panel). `/${org}/~/agent` IS NOT A ROUTE ANY MORE — there is no
//     `app/(private)/[org]/~/agent` directory — and the six tests that drove it were deleted with
//     it (#4272). They had been recorded `failed` in gate-baseline.json, which reads as debt on a
//     surface someone will fix; the surface is gone, so the honest ledger entry is no entry.
//   • /${org}/~/usage   — components/settings/usage/usage-panel.tsx: plan & limits meters,
//                         resources, the over-time CSS bar chart + its range picker + metric tabs,
//                         AI plan & usage.
//   • /${org}/~/settings/activity — components/settings/activity/*: the natural-language audit feed
//                         + the reusable filter bar, ON THE CONSOLE FILTER STANDARD (both halves —
//                         see "Activity — the seven filter keys" below).
//   • account menu → Settings dialog — components/shell/account-settings-dialog.tsx.
//
// Personas: `owner` = Hobby (community, free), `team` = Pro (card-less trialing). Gating /
// validation / empty-state paths live in agent-usage-activity.negative.spec.ts.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT RE-TEST ────────────────────────────────────────────
// `e2e/elench-agent.spec.ts` (the `console` leg) already drives the assistant's INSIDE: the
// fullscreen modal's empty landing, the composer, the Ask-mode popover, minimize ↔ maximize,
// thread persistence and the AI-off 503. Repeating any of that here would buy a second copy of a
// measurement, not a second measurement. What this file owns is the one thing that spec cannot
// say, because it opens the panel from the org home: that the launcher is a TOPBAR affordance
// available from an arbitrary authenticated route.

import { seedProject } from "../helpers/seed";
import { expect, test } from "../fixtures/qa";

const usagePath = (slug: string) => `/${slug}/~/usage`;
const activityPath = (slug: string) => `/${slug}/~/settings/activity`;

// The QA console at :3100 is shared across parallel agents — GETs can spike under load. Give each
// test headroom so a slow render never masquerades as a real failure.
test.beforeEach(() => {
	test.setTimeout(120_000);
});

// ── Agent — reached from the topbar ─────────────────────────────────────────────────────────
test.describe("Agent — reached from the topbar (owner)", () => {
	test("Ask AI opens the assistant as a docked panel from an arbitrary route", async ({
		owner,
	}) => {
		// Deliberately NOT the org home: `ask-ai-button.tsx` promises the launcher on "every
		// authenticated view", and the org home is the one view elench-agent.spec.ts already
		// proves. A settings-shaped route is the other side of that promise.
		await owner.page.goto(usagePath(owner.orgSlug));
		await expect(owner.page).not.toHaveURL(/\/login/);

		await owner.page.getByRole("button", { name: "Ask AI" }).click();

		// Two assertions, and the second is the load-bearing one. The panel is a `role="dialog"`
		// labelled "Elench assistant" (elench-panel.tsx) — but a dialog can be present and empty,
		// so the composer, which only the OPEN surface mounts, is what proves the click did
		// something rather than that something was already there.
		const panel = owner.page.getByRole("dialog", { name: /elench assistant/i });
		await expect(panel).toBeVisible({ timeout: 30_000 });
		await expect(owner.page.getByTestId("elench-composer")).toBeVisible();
	});
});

// ── Usage — meters + over-time chart ────────────────────────────────────────────────────────
//
// ALL NINE `Usage —` TESTS CARRY `@needs:stripe`, and the two Pro ones are not the only reason.
// `UsagePanel` is fronted by `getBillingSummary()` (app/server/actions/billing.ts), which resolves
// the org's LIVE subscription through Stripe whenever the org has one, and overrides the plan,
// the status and the period the card renders with what it finds. The `team` persona has one, so
// its card is Stripe's answer; the Hobby card is only meaningful as the other side of that
// comparison. Tagging the surface — not just the two tests that name "Pro" — is what makes "this
// leg measured the plan" a true sentence. The `qa` leg promises `stripe`
// (.github/workflows/release-gate.yml); on a leg that does not, `fixtures/qa.ts` fails the test in
// CI and skips it locally with a reason that begins NOT MEASURED. Never a `test.skip(!env)`.
test.describe("Usage — meters + over-time chart", () => {
	test(
		"authed persona reaches usage (not bounced to /login)",
		{ tag: "@needs:stripe" },
		async ({ owner }) => {
			await owner.page.goto(usagePath(owner.orgSlug));
			await expect(owner.page).not.toHaveURL(/\/login/);
			await expect(
				owner.page.getByRole("heading", { name: "Plan & limits", level: 2 }),
			).toBeVisible({ timeout: 30_000 });
		},
	);

	test(
		"the four taxonomy sections all render, as the page's outline",
		{ tag: "@needs:stripe" },
		async ({ owner }) => {
			await owner.page.goto(usagePath(owner.orgSlug));
			// `SettingsSection` renders its title through `SectionHeading level={2}`, i.e. an
			// `<h2>` — so these are the page's OUTLINE, not four strings that happen to be on
			// screen. Located by role for that reason, and because `getByText` here was wrong in
			// a way nothing caught: the fourth section is titled "AI plan & usage"
			// (ai-usage-section.tsx:111), and the old assertion asked for "AI usage", which is a
			// substring of nothing. It had been red in the ledger for that alone.
			await expect(
				owner.page.getByRole("heading", { name: "Plan & limits", level: 2 }),
			).toBeVisible({ timeout: 30_000 });
			await expect(
				owner.page.getByRole("heading", { name: "Usage over time", level: 2 }),
			).toBeVisible();
			await expect(
				owner.page.getByRole("heading", { name: "Resources", level: 2 }),
			).toBeVisible();
			await expect(
				owner.page.getByRole("heading", { name: "AI plan & usage", level: 2 }),
			).toBeVisible();
		},
	);

	test(
		"plan & limits shows the three point-in-time meters",
		{ tag: "@needs:stripe" },
		async ({ owner }) => {
			await owner.page.goto(usagePath(owner.orgSlug));
			await expect(owner.page.getByText("Seats")).toBeVisible({ timeout: 30_000 });
			await expect(owner.page.getByText("Runner minutes").first()).toBeVisible();
			await expect(owner.page.getByText("Concurrency")).toBeVisible();
		},
	);

	test(
		"the cloud-spend disclaimer is surfaced",
		{ tag: "@needs:stripe" },
		async ({ owner }) => {
			await owner.page.goto(usagePath(owner.orgSlug));
			await expect(
				owner.page.getByText(/cloud-resource spend is billed separately/i),
			).toBeVisible({ timeout: 30_000 });
		},
	);

	test(
		"switching the quick range updates the over-time trigger label",
		{ tag: "@needs:stripe" },
		async ({ owner }) => {
			await owner.page.goto(usagePath(owner.orgSlug));
			await expect(
				owner.page.getByRole("heading", { name: "Usage over time", level: 2 }),
			).toBeVisible({ timeout: 30_000 });

			// The picker's trigger carries the CURRENT label, and the popover's preset list
			// carries every label — including the current one. So the trigger is addressed
			// through the section's own action area, and the preset through the open popover,
			// or `Last 7 days` is ambiguous the moment the popover is up.
			const trigger = owner.page.getByRole("button", { name: /^Last 7 days$/i });
			await trigger.click();
			await owner.page.getByRole("button", { name: "Last 14 days", exact: true }).click();

			// The popover closes on apply (quick-range-filter.tsx `apply()`), so exactly one
			// node can carry this name afterwards — which is what makes it an assertion about
			// the TRIGGER rather than about the list we just clicked in.
			await expect(
				owner.page.getByRole("button", { name: /^Last 14 days$/i }),
			).toBeVisible();
		},
	);

	test(
		"the over-time metric tabs say WHICH series is showing, accessibly",
		{ tag: "@needs:stripe" },
		async ({ owner }) => {
			await owner.page.goto(usagePath(owner.orgSlug));
			const jobs = owner.page.getByRole("button", { name: "Jobs", exact: true });
			const minutes = owner.page.getByRole("button", { name: "Runner minutes", exact: true });
			await expect(jobs).toBeVisible({ timeout: 30_000 });

			// `aria-pressed`, NOT `aria-selected`, and not a class either.
			//
			// The old assertion was `toHaveClass(/bg-surface-muted/)` — a Tailwind utility, which
			// says nothing about what a screen-reader user is told and goes red on a restyle that
			// broke nothing. The accessible state is the thing to assert.
			//
			// It is `aria-pressed` because `usage-primitives.tsx:275-281` RULED on this: these are
			// toggle buttons in a `role="group"` labelled "Metric", deliberately not
			// `role="tab"` + `aria-selected`, because the tab role promises the whole APG pattern
			// (a `tabpanel` per tab, roving tabindex, arrow-key navigation) and a tablist that
			// announces "tab 1 of 3" and then ignores an arrow key is worse than plain buttons.
			// A test that demanded `aria-selected` here would be asking for that regression back.
			await expect(minutes).toHaveAttribute("aria-pressed", "true");
			await expect(jobs).toHaveAttribute("aria-pressed", "false");

			await jobs.click();
			// The state MOVED — both halves, so a control that reports every tab pressed cannot
			// pass this.
			await expect(jobs).toHaveAttribute("aria-pressed", "true");
			await expect(minutes).toHaveAttribute("aria-pressed", "false");
		},
	);

	test(
		"Hobby usage exposes the inline Upgrade to Pro CTA",
		{ tag: "@needs:stripe" },
		async ({ owner }) => {
			await owner.page.goto(usagePath(owner.orgSlug));
			await expect(
				owner.page.getByRole("button", { name: /upgrade to pro/i }).first(),
			).toBeVisible({ timeout: 30_000 });
		},
	);
});

test.describe("Usage — Pro trial (team)", () => {
	test(
		"Pro usage shows the plan name and Manage billing (no upgrade CTA)",
		{ tag: "@needs:stripe" },
		async ({ team }) => {
			await team.page.goto(usagePath(team.orgSlug));
			await expect(team.page.getByText("Pro plan")).toBeVisible({ timeout: 30_000 });
			await expect(team.page.getByRole("link", { name: /manage billing/i })).toBeVisible();
		},
	);

	test(
		"Pro usage exposes the spend-control hard-cap toggle",
		{ tag: "@needs:stripe" },
		async ({ team }) => {
			await team.page.goto(usagePath(team.orgSlug));
			await expect(
				team.page.getByText(/pause new jobs at my included minutes/i),
			).toBeVisible({ timeout: 30_000 });
		},
	);
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
		await expect(owner.page.getByRole("button", { name: /^events$/i })).toBeVisible();
	});

	test("the Events sheet's groups EXPAND to their options", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /^events$/i }).click();
		const sheet = owner.page.getByRole("dialog");
		await expect(sheet.getByText("Result", { exact: true })).toBeVisible({
			timeout: 15_000,
		});

		// EVERY GROUP STARTS COLLAPSED, and the old test did not know it. `GroupedFilterSheet`'s
		// `Group` opens with `useState(count > 0)` (packages/ui/src/grouped-filter-sheet.tsx), so
		// on a pristine filter every group is shut and "Allowed"/"Denied" are in a
		// `CollapsibleContent` that is not rendered. The old assertion asked for them straight
		// after opening the sheet and had been recorded `failed` for it — a test red on the test,
		// not on the product.
		await sheet.getByText("Result", { exact: true }).click();
		await expect(sheet.getByText("Denied", { exact: true })).toBeVisible();
		await expect(sheet.getByText("Allowed", { exact: true })).toBeVisible();
	});

	test("the quick-range filter is present on the feed", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		await expect(
			owner.page.getByRole("button", { name: /^Last 7 days$/i }),
		).toBeVisible({ timeout: 30_000 });
	});
});

// ── Activity — the seven filter keys ────────────────────────────────────────────────────────
//
// `ActivityFilters` (components/settings/activity/activity-filters.ts) has exactly seven fields —
// `search, actorIds, projectIds, eventTokens, from, to, rangeLabel` — and `useFilterUrlSync`
// mirrors each one into the search params under its own name. That mirror is the console filter
// standard's shareable-view half, and until now NOTHING measured it: every activity test drove a
// control and looked at the feed, which passes just as well if the URL is never written.
//
// So both directions, because they fail independently:
//   • URL → store, on mount ("a pasted link shows what it says"), and
//   • store → URL, on every change.
test.describe("Activity — the seven filter keys round-trip through the URL (owner)", () => {
	test("a pasted link hydrates search and the three facet selections", async ({ owner }) => {
		// Real ids, not placeholders: `actorIds` and `projectIds` are handed to the server query,
		// and a made-up id would send the feed to its error branch — which still renders the
		// filter bar, so the assertions below would pass while measuring a broken page.
		//
		// `userId`/`orgId` are optional on `PersonaRecord` (global-setup resolves them from the
		// DB), so an absent one is failed LOUDLY rather than seeded against `undefined` — the
		// same reason the negative spec's project seed throws.
		const { userId, orgId } = owner;
		if (!userId || !orgId) {
			throw new Error("ownerHobby persona has no userId/orgId — global-setup did not complete");
		}
		const project = await seedProject(
			{ userId, orgId },
			{ name: `e2e-activity-url-${Date.now()}` },
		);
		const params = new URLSearchParams({
			search: "grant",
			actorIds: userId,
			projectIds: project.projectId,
			eventTokens: "result:deny",
		});
		await owner.page.goto(`${activityPath(owner.orgSlug)}?${params}`);

		await expect(
			owner.page.getByPlaceholder(/search actor, action or resource/i),
		).toHaveValue("grant", { timeout: 30_000 });
		// A facet trigger renders a count badge only when something is selected, so "User 1" is
		// a name that exists ONLY once the URL has been decoded into the store.
		await expect(owner.page.getByRole("button", { name: /^user 1$/i })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /^project 1$/i })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /^events 1$/i })).toBeVisible();
	});

	test("a pasted link hydrates the window and its label", async ({ owner }) => {
		// A window INSIDE Hobby's 7-day retention: the retention guard lives in `applyRange`, so
		// hydration is not gated by it, but a window the plan cannot show would make every later
		// interaction in this test meaningless.
		const to = new Date();
		const from = new Date(to.getTime() - 2 * 86_400_000);
		const params = new URLSearchParams({
			from: from.toISOString(),
			to: to.toISOString(),
			rangeLabel: "Last 2 days",
		});
		await owner.page.goto(`${activityPath(owner.orgSlug)}?${params}`);

		// `rangeLabel` is carried precisely because it cannot be recovered from `from`/`to`
		// (activity-filters.ts) — so the trigger reading it back IS the test for that key, and
		// its arrival also proves the mount-hydration effect has run.
		await expect(
			owner.page.getByRole("button", { name: /^Last 2 days$/i }),
		).toBeVisible({ timeout: 30_000 });

		// `from`/`to` SURVIVING the round-trip is the assertion, not a formatted date on the
		// calendar trigger (which would be a test of `formatRangeLabel`'s locale, and of the CI
		// box's timezone, wearing this test's name). The store→URL effect rewrites the whole
		// query string from the store and DELETES every key whose value equals its default — so
		// a `from`/`to` that failed to hydrate would be actively removed from the address bar,
		// not merely unread.
		await expect(owner.page).toHaveURL(/[?&]from=\d{4}-\d{2}-\d{2}T/);
		await expect(owner.page).toHaveURL(/[?&]to=\d{4}-\d{2}-\d{2}T/);
	});

	test("typing a search writes `search` to the URL", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		const search = owner.page.getByPlaceholder(/search actor, action or resource/i);
		await expect(search).toBeVisible({ timeout: 30_000 });
		await search.fill("connector");
		// `toHaveURL` polls, which is what absorbs the 300ms debounce without a sleep.
		await expect(owner.page).toHaveURL(/[?&]search=connector\b/, { timeout: 15_000 });
	});

	test("picking an event writes `eventTokens` to the URL", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		await owner.page.getByRole("button", { name: /^events$/i }).click();
		const sheet = owner.page.getByRole("dialog");
		await sheet.getByText("Result", { exact: true }).click();
		await sheet.getByText("Denied", { exact: true }).click();

		// `result%3Adeny` — the codec joins an array with commas and `URLSearchParams` escapes
		// the colon. Asserting the ENCODED token is the point: it is the shape a pasted link has
		// to survive, and the previous test proves the decode side of the same string.
		await expect(owner.page).toHaveURL(/[?&]eventTokens=result%3Adeny\b/, {
			timeout: 15_000,
		});
	});

	test("picking a window writes `from`, `to` and `rangeLabel` to the URL", async ({ owner }) => {
		await owner.page.goto(activityPath(owner.orgSlug));
		await expect(
			owner.page.getByRole("button", { name: /^Last 7 days$/i }),
		).toBeVisible({ timeout: 30_000 });
		await owner.page.getByRole("button", { name: /^Last 7 days$/i }).click();

		// The "yesterday" relative chip, not a preset: every preset shorter than the default is
		// the default, and the next one up (14 days) predates Hobby's 7-day retention and opens
		// the upgrade sheet instead of applying — which is the negative spec's test, not this one.
		await owner.page.getByText("yesterday", { exact: true }).click();

		await expect(owner.page).toHaveURL(/[?&]rangeLabel=yesterday\b/, { timeout: 15_000 });
		await expect(owner.page).toHaveURL(/[?&]from=\d{4}-\d{2}-\d{2}T/);
		await expect(owner.page).toHaveURL(/[?&]to=\d{4}-\d{2}-\d{2}T/);
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
