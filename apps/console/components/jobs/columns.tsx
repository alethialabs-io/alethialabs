"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { StatusBadge } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@repo/ui/tooltip";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@repo/ui/hover-card";
import { PROVIDER_LABELS, ProviderIcon } from "@repo/ui/provider-icon";
import { lookup } from "@/lib/typed-object";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import type { ProvisionJobStatus, ProvisionJobType } from "@/lib/db/schema";
import { formatDuration, formatRelative } from "@repo/format";
import { JOB_TYPES } from "@/lib/jobs/format";
import { JobAuthor, type JobAuthorInfo } from "@/components/jobs/job-author";
import { ReleaseNotesPopover } from "@/components/runners/release-notes-popover";
import { projectHref } from "@/lib/routing";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowRight, Layers, Server } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { useHydrated } from "@/hooks/use-hydrated";

export { JOB_TYPES };

/** A job row enriched with joined project/runner/provider/environment data (the jobs page read). */
type JobRow = JobWithMeta;

/** A job's detail page. */
export function jobHref(orgSlug: string, jobId: string): string {
  return `/${orgSlug}/~/jobs/${jobId}`;
}

const RUNNING = new Set(["QUEUED", "CLAIMED", "PROCESSING"]);

/**
 * Ticks once a second so an in-flight job's elapsed time stays live.
 *
 * The rows are server-rendered since the jobs page prefetches them (#6113), and "now" on the server
 * is not "now" in the hydrating browser: printing the elapsed time during hydration is a text
 * mismatch, React #418, and React throws the page's server HTML away. So the clock is read only
 * once hydration is over (`useHydrated`, #5786) — the row itself still paints on first load.
 */
export function LiveDuration({ createdAt }: { createdAt: Date | string }) {
  const hydrated = useHydrated();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <ClockSlot sizer={DURATION_SIZER} className="text-xs tabular-nums text-muted-foreground">
      {hydrated ? formatDuration(Date.now() - new Date(createdAt).getTime()) : null}
    </ClockSlot>
  );
}

/**
 * "3 minutes ago", read against the browser's clock only after hydration — for the same #418
 * reason as `LiveDuration`. `<time>` carries the instant itself for assistive tech meanwhile.
 */
export function RelativeTime({ at }: { at: Date | string }) {
  const hydrated = useHydrated();
  const instant = new Date(at);
  // A value that is not a date (a malformed string, Postgres `infinity`) must not take the whole
  // table down: `toISOString()` throws on it, and `formatRelative` already answers "—".
  if (Number.isNaN(instant.getTime())) {
    return <span className="text-xs text-muted-foreground">{formatRelative(null)}</span>;
  }
  return (
    <time dateTime={instant.toISOString()} className="text-xs text-muted-foreground">
      <ClockSlot sizer={RELATIVE_SIZER}>{hydrated ? formatRelative(instant) : null}</ClockSlot>
    </time>
  );
}

/** Widest strings each clock cell prints, so the slot is that wide before the clock is read. */
const RELATIVE_SIZER = "less than a minute ago";
const DURATION_SIZER = "00h 00m";

/**
 * Reserves the clock text's width while it is blank during hydration, so the table does not
 * reflow when the text arrives a commit later (the invisible-sizer pattern of #5849). The sizer
 * and the text share one grid cell; the wider of the two sets the width.
 */
export function ClockSlot({
  sizer,
  className,
  children,
}: {
  sizer: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span className={cn("inline-grid whitespace-nowrap", className)}>
      <span aria-hidden className="invisible col-start-1 row-start-1">
        {sizer}
      </span>
      <span className="col-start-1 row-start-1">{children}</span>
    </span>
  );
}

/** Renders a grayscale job status, with a tooltip surfacing the error on FAILED. */
function JobStatus({
  status,
  errorMessage,
}: {
  status: ProvisionJobStatus;
  errorMessage?: string | null;
}) {
  const badge = <StatusBadge status={status} />;
  if (status === "FAILED" && errorMessage) {
    const truncated =
      errorMessage.length > 120
        ? `${errorMessage.slice(0, 120)}...`
        : errorMessage;
    return (
      <Tooltip>
        <TooltipTrigger render={badge} />
        <TooltipContent side="top" className="max-w-xs text-xs">
          {truncated}
        </TooltipContent>
      </Tooltip>
    );
  }
  return badge;
}

/**
 * The Project cell — the provider logo (full color when the job's cloud identity is connected,
 * grayscale otherwise) + a truncating project name, wrapped in a HoverCard that surfaces the
 * provider and a link to open the project. Rows are clickable, so the trigger stops propagation.
 */
function ProjectCell({
  orgSlug,
  projectName,
  projectSlug,
  provider,
  connected,
}: {
  orgSlug: string;
  projectName: string | null;
  projectSlug: string | null;
  provider: string | null;
  connected: boolean;
}) {
  const icon = provider ? (
    <ProviderIcon
      provider={provider}
      size={18}
      mono={!connected}
      className="shrink-0"
    />
  ) : null;

  // No project (e.g. an org-level job) — nothing to link to, so skip the hover card.
  if (!projectName) {
    return (
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-xs text-muted-foreground">—</span>
      </div>
    );
  }

  const label = provider
    ? (lookup(PROVIDER_LABELS, provider) ?? provider)
    : null;

  return (
    <HoverCard>
      <HoverCardTrigger
        delay={150}
        closeDelay={80}
        render={
          <button
            type="button"
            onClick={(e) => e.stopPropagation()}
            className="flex min-w-0 max-w-[220px] items-center gap-1.5 text-left"
          >
            {icon}
            <span className="truncate text-xs font-medium text-foreground">
              {projectName}
            </span>
          </button>
        }
      />
      <HoverCardContent align="start" className="w-64 p-3">
        <div className="flex items-center gap-2">
          {provider && (
            <ProviderIcon
              provider={provider}
              size={22}
              mono={!connected}
              className="shrink-0"
            />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {projectName}
            </p>
            {label && (
              <p className="text-ui-xs text-muted-foreground">{label}</p>
            )}
          </div>
        </div>
        {projectSlug && (
          <Link
            href={projectHref(orgSlug, projectSlug)}
            onClick={(e) => e.stopPropagation()}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
          >
            Open project
            <ArrowRight className="size-3" />
          </Link>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The Runner cell — the runner name; for a real release version (not `dev`), it's a button that
 * opens the release-notes / changelog popover (the same one the runners table uses). Stops row
 * propagation so opening the popover doesn't navigate to the job.
 */
function RunnerCell({
  runnerId,
  runnerName,
  runnerVersion,
}: {
  runnerId: string | null;
  runnerName: string | null;
  runnerVersion: string | null;
}) {
  if (!runnerId && !runnerName)
    return <span className="text-xs text-muted-foreground">—</span>;

  const name = runnerName ?? runnerId?.slice(0, 8);
  const isRelease = Boolean(runnerVersion) && runnerVersion !== "dev";

  if (!isRelease) {
    return (
      <div className="flex items-center gap-1.5">
        <Server className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs text-foreground">{name}</span>
        {runnerVersion && (
          <span className="font-mono text-ui-2xs text-muted-foreground">
            {runnerVersion}
          </span>
        )}
      </div>
    );
  }

  return (
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <ReleaseNotesPopover version={runnerVersion}>
        <button type="button" className="flex items-center gap-1.5 text-left">
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs text-foreground hover:underline">
            {name}
          </span>
          <span className="font-mono text-ui-2xs text-muted-foreground">
            v{runnerVersion}
          </span>
        </button>
      </ReleaseNotesPopover>
    </span>
  );
}

/**
 * The jobs table columns. `showProject` is false in a project-scoped context (the project is
 * implied). `authorById` resolves each job's initiator to the org-member identity for the avatar.
 * `orgSlug` builds the project link in the Project cell's hover card.
 */
export function buildJobColumns({
  showProject = true,
  authorById,
  orgSlug,
}: {
  showProject?: boolean;
  authorById: Map<string, JobAuthorInfo>;
  orgSlug: string;
}): ColumnDef<JobRow>[] {
  const columns: ColumnDef<JobRow>[] = [
    {
      accessorKey: "job_type",
      header: "Type",
      enableSorting: true,
      cell: ({ row }) => {
        const type = row.getValue<ProvisionJobType>("job_type");
        const info = JOB_TYPES[type];
        const Icon = info?.icon;
        // The row's REAL LINK (F025): an `<a href>` to the job, so a cmd-, ctrl- or middle-click
        // opens it in a new tab and "copy link" works. The row's own click handler covers a plain
        // click anywhere else on the row; the link stops that click from navigating twice.
        return (
          <Link
            href={jobHref(orgSlug, row.original.id)}
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <div className="min-w-0">
              <span className="text-xs font-medium">{info?.label ?? type}</span>
              {info && (
                <p className="hidden text-ui-2xs text-muted-foreground sm:block">
                  {info.description}
                </p>
              )}
            </div>
          </Link>
        );
      },
    },
    {
      accessorKey: "status",
      header: "Status",
      enableSorting: true,
      cell: ({ row }) => {
        const { status, created_at, completed_at, error_message } =
          row.original;
        const running = !completed_at && RUNNING.has(status);
        return (
          <div className="flex items-center gap-2">
            <JobStatus status={status} errorMessage={error_message} />
            {created_at && running ? (
              <LiveDuration createdAt={created_at} />
            ) : created_at && completed_at ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatDuration(
                  new Date(completed_at).getTime() -
                    new Date(created_at).getTime(),
                )}
              </span>
            ) : null}
          </div>
        );
      },
    },
  ];

  if (showProject) {
    columns.push({
      accessorKey: "project_id",
      header: "Project",
      enableSorting: false,
      cell: ({ row }) => {
        const {
          project_name,
          project_slug,
          cloud_provider,
          cloud_identity_status,
        } = row.original;
        // A degraded identity authenticated fine (it just lacks some provisioning
        // permissions) — it still counts as connected for the color treatment.
        const connected =
          cloud_identity_status === "connected" ||
          cloud_identity_status === "degraded";
        return (
          <ProjectCell
            orgSlug={orgSlug}
            projectName={project_name}
            projectSlug={project_slug}
            provider={cloud_provider}
            connected={connected}
          />
        );
      },
    });
  }

  columns.push(
    {
      accessorKey: "runner_id",
      header: "Runner",
      enableSorting: false,
      cell: ({ row }) => {
        const { runner_id, runner_name, runner_version } = row.original;
        return (
          <RunnerCell
            runnerId={runner_id}
            runnerName={runner_name}
            runnerVersion={runner_version}
          />
        );
      },
    },
    {
      id: "environment",
      header: "Environment",
      enableSorting: false,
      cell: ({ row }) => {
        const { environment_name } = row.original;
        if (!environment_name)
          return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <div className="flex items-center gap-1.5">
            <Layers className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="text-xs text-foreground">{environment_name}</span>
          </div>
        );
      },
    },
    {
      id: "when",
      header: "Initiated",
      enableSorting: true,
      accessorFn: (row) => row.created_at,
      cell: ({ row }) => {
        const { created_at, user_id } = row.original;
        const author = user_id ? (authorById.get(user_id) ?? null) : null;
        return (
          <div className="flex items-center justify-end gap-2">
            {created_at && (
              <RelativeTime at={created_at} />
            )}
            <JobAuthor author={author} />
          </div>
        );
      },
    },
  );

  return columns;
}
