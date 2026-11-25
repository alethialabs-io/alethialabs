"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Overview toolbar — the console filter standard, as the clusters and environments bars draw it:
// the search, the shared CloudFilter, a Repository FacetFilter and the mono Reset; then the sort
// order (Activity / Name), the card/table view toggle and a Create menu. It used to fold the two
// facets and the sort into one bespoke funnel popover, so the overview's filters looked and worked
// unlike every other list's (R6 B-24). All state is owned by the page (URL search params) — the
// console filter standard's blessed URL→RSC variant — so this component only emits `onChange`.
// Every facet count was tallied over the unfiltered universe by the grid's read.

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, GitBranch, Plus } from "lucide-react";
import { Button } from "@repo/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { FacetFilter } from "@repo/ui/facet-filter";
import { FilterBar, FilterBarReset } from "@repo/ui/filter-bar";
import { FilterSearch } from "@repo/ui/filter-search";
import { ViewToggle } from "@repo/ui/view-toggle";
import { CloudFilter } from "@/components/filters/cloud-filter";
import type { ProjectsFacets } from "@/lib/queries/projects";
import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";
import type { OverviewState } from "@/components/overview/overview-state";
import { providerLabel } from "@/components/overview/project-cloud";
import { overviewUsageQuery } from "@/components/overview/usage-card";
import { UpgradeDialog } from "@/components/settings/upgrade/upgrade-dialog";
import { CLOUD_ACCOUNT, ORGANIZATION, PROJECT, sentenceStart } from "@/lib/copy/vocabulary";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { globalHref } from "@/lib/routing";

/** The reason on "Organization member" while the plan read that decides it has not answered. */
export const INVITE_PENDING_REASON = "Checking your plan.";

/** The reason on "Organization member" when that read failed: the Usage card on this page retries it. */
export const INVITE_UNKNOWN_REASON =
  "Couldn't check your plan. Retry the Usage card.";

/** The filter dims Reset clears (view + sort are not filters, so they don't count). */
const FILTER_DEFAULTS = {
  q: "",
  clouds: Array<string>(),
  repos: Array<string>(),
};

export function OverviewToolbar({
  orgSlug,
  state,
  facets,
  createProjectReason,
  onChange,
}: {
  orgSlug: string;
  state: OverviewState;
  /** The facet universe from the grid's read; empty until it has answered. */
  facets: ProjectsFacets;
  /** Why the viewer cannot create a project right now, or `null` when they can. */
  createProjectReason: string | null;
  onChange: (next: Partial<OverviewState>) => void;
}) {
  // Local, immediate draft for the search box; the URL (server query) updates on a debounce.
  const [draft, setDraft] = useState(state.q);
  // Adopt an external change to the query (e.g. a Reset, or navigation) into the draft —
  // React's "adjust state during render" pattern, so it stays in sync without an effect.
  const [syncedQ, setSyncedQ] = useState(state.q);
  if (state.q !== syncedQ) {
    setSyncedQ(state.q);
    setDraft(state.q);
  }
  useEffect(() => {
    if (draft === state.q) return;
    const id = setTimeout(() => onChange({ q: draft }), 300);
    return () => clearTimeout(id);
  }, [draft, state.q, onChange]);

  return (
    <FilterBar
      end={
        <div className="flex items-center gap-2.5">
          <SortMenu sort={state.sort} onChange={onChange} />
          <ViewToggle
            value={state.view}
            onChange={(view) => onChange({ view })}
          />
          <CreateMenu orgSlug={orgSlug} createProjectReason={createProjectReason} />
        </div>
      }
    >
      <FilterSearch
        value={draft}
        onChange={setDraft}
        placeholder="Search projects…"
        ariaLabel="Search projects"
        className="min-w-[200px] flex-1"
      />
      <CloudFilter
        value={state.clouds}
        onChange={(clouds) => onChange({ clouds })}
        options={facets.clouds.map((c) => ({
          value: c.value,
          label: providerLabel(c.value),
          count: c.count,
        }))}
      />
      <FacetFilter
        label="Repository"
        icon={GitBranch}
        searchPlaceholder="Search repositories…"
        options={facets.repos.map((r) => ({
          value: r.url,
          label: r.label,
          count: r.count,
        }))}
        value={state.repos}
        onChange={(repos) => onChange({ repos })}
      />
      <FilterBarReset
        count={countActiveFilters(
          { q: state.q, clouds: state.clouds, repos: state.repos },
          FILTER_DEFAULTS,
        )}
        onReset={() => onChange({ q: "", clouds: [], repos: [] })}
      />
    </FilterBar>
  );
}

/** What each sort order is called, on its menu item and on the trigger. */
const SORT_LABELS: Record<OverviewState["sort"], string> = {
  activity: "Activity",
  name: "Name",
};

/** Narrows a menu value to one of the grid's two sort orders. */
function isSortOrder(value: unknown): value is OverviewState["sort"] {
  return value === "activity" || value === "name";
}

/**
 * The sort order, as a menu of radio items. Sorting is not a filter, so it sits beside the view
 * toggle rather than among the facets, and Reset does not count it.
 */
function SortMenu({
  sort,
  onChange,
}: {
  sort: OverviewState["sort"];
  onChange: (next: Partial<OverviewState>) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" className="gap-1.5" aria-label={`Sort by ${SORT_LABELS[sort]}`}>
            <ArrowDownUp aria-hidden className="size-3.5" />
            {SORT_LABELS[sort]}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
          Sort by
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sort}
          onValueChange={(value: unknown) => {
            if (isSortOrder(value)) onChange({ sort: value });
          }}
        >
          <DropdownMenuRadioItem value="activity">{SORT_LABELS.activity}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="name">{SORT_LABELS.name}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "Create" menu: a project, a cloud account, an organization member.
 *
 * Each entry that the viewer cannot use right now is disabled WITH its reason, and none opens a
 * surface chosen from an answer the console does not have yet. The member entry is decided by the
 * plan (`canInvite`, on the overview's usage read): while that read is pending or has failed the
 * entry says so, and only a read that answered "no" opens the upgrade dialog.
 */
function CreateMenu({
  orgSlug,
  createProjectReason,
}: {
  orgSlug: string;
  createProjectReason: string | null;
}) {
  const router = useRouter();
  // Dialogs render outside the menu so they survive it closing.
  const [inviteOpen, setInviteOpen] = useState(false);
  const [upsellOpen, setUpsellOpen] = useState(false);
  // The invite gate rides on the overview's usage read (prefetched by the page, #6118): the same
  // cache entry the Usage card reads, so it costs no request of its own.
  const usage = useQuery({
    ...overviewUsageQuery(),
    select: (answer) => answer.canInvite,
  });
  const canInvite = usage.data;
  const inviteReason =
    canInvite !== undefined
      ? null
      : usage.isError
        ? INVITE_UNKNOWN_REASON
        : INVITE_PENDING_REASON;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button size="default" className="gap-1.5">
              <Plus aria-hidden className="h-4 w-4" />
              Create
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="font-mono text-ui-3xs uppercase tracking-wider text-muted-foreground">
            Create
          </DropdownMenuLabel>
          <DropdownMenuItem
            disabledReason={createProjectReason}
            onSelect={() => router.push(globalHref(orgSlug, "new"))}
          >
            {sentenceStart(PROJECT.one)}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              router.push(`${globalHref(orgSlug, "connectors")}?type=cloud`)
            }
          >
            {sentenceStart(CLOUD_ACCOUNT.one)}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabledReason={inviteReason}
            onSelect={() =>
              canInvite ? setInviteOpen(true) : setUpsellOpen(true)
            }
          >
            {sentenceStart(ORGANIZATION.one)} member
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Controlled, trigger-less — opened from the member item above. */}
      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} />
      <UpgradeDialog
        feature="invite"
        open={upsellOpen}
        onOpenChange={setUpsellOpen}
      />
    </>
  );
}
