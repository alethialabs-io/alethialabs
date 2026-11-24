"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Runner action + version controls, shared by the runner card. Extracted from the
// former table columns when the runners list moved to cards.

import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/tooltip";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { ReleaseNotesPopover } from "@/components/runners/release-notes-popover";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
import {
  useRunnersQuery,
  useSetDefaultRunner,
  useDestroyRunner,
  useDeleteRunner,
  type RunnerView,
} from "@/lib/query/use-runners-query";
import { globalHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { ArrowUpCircle, Loader2, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

/** Why the default star is not available on a personal-workspace runner listed from a team org. */
export const PERSONAL_RUNNER_DEFAULT_REASON =
  "Switch to your personal workspace to change its default";

/** What a runner destroy removes, listed in its typed confirmation (R6 C-20). */
const RUNNER_DESTROY_CONSEQUENCES = [
  "Every cloud resource this runner was deployed with is torn down.",
  "The runner is deleted and is no longer given jobs.",
] as const;

/** A runner with its in-flight job (if any), joined on the server — the unit the card renders. */
export type RunnerRow = RunnerView;

/** The lifecycle job currently acting on a runner, or null when idle. */
export function runnerBusyKind(
  runner: RunnerRow,
): "DEPLOY_RUNNER" | "UPDATE_RUNNER" | "DESTROY_RUNNER" | null {
  const t = runner.active_job?.job_type;
  if (
    t === "DEPLOY_RUNNER" ||
    t === "UPDATE_RUNNER" ||
    t === "DESTROY_RUNNER"
  ) {
    return t;
  }
  return null;
}

/** Version label for a runner with an inline popover of its release notes, plus an
 *  "update available" badge (also a popover, with the Update action) when outdated. */
export function RunnerVersion({ runner }: { runner: RunnerRow }) {
  const { data: runnersData } = useRunnersQuery();
  const latestRelease = runnersData?.latestRelease ?? null;

  const release = runner.runner_releases;
  const displayVersion = release?.version ?? runner.version;
  const isRelease = displayVersion && displayVersion !== "dev";
  const isOutdated =
    latestRelease && isRelease && displayVersion !== latestRelease.version;

  return (
    <span
      className="flex items-center gap-1.5"
      onClick={(e) => e.stopPropagation()}
    >
      {displayVersion ? (
        isRelease ? (
          <ReleaseNotesPopover version={displayVersion}>
            <button
              type="button"
              className="cursor-pointer font-mono text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
            >
              v{displayVersion}
            </button>
          </ReleaseNotesPopover>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {displayVersion}
          </span>
        )
      ) : (
        <span className="font-mono text-xs text-muted-foreground">Unknown</span>
      )}
      {isOutdated && (
        <ReleaseNotesPopover
          version={latestRelease.version}
          runnerId={runner.id}
          isOutdated
        >
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button">
                    <Badge
                      variant="outline"
                      className="gap-1 cursor-pointer border-border bg-muted py-0 text-ui-2xs text-muted-foreground hover:bg-muted/80"
                    >
                      <ArrowUpCircle className="h-3 w-3" />v
                      {latestRelease.version}
                    </Badge>
                  </button>
                }
              />
              <TooltipContent side="top" className="text-xs">
                Click to view release notes
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </ReleaseNotesPopover>
      )}
    </span>
  );
}

/** The default-star toggle + destroy/remove controls for a runner. While a lifecycle job
 *  is in flight it renders a link to that job instead. */
export function RunnerActions({ runner }: { runner: RunnerRow }) {
  const router = useRouter();
  const orgSlug = useActiveOrgSlug();
  const setDefault = useSetDefaultRunner();
  const destroy = useDestroyRunner();
  const remove = useDeleteRunner();
  const [showRemoveDialog, setShowRemoveDialog] = useState(false);
  // The destroy is two steps (R6 C-20): the popover picks which runner carries out the destroy job,
  // then the typed confirmation names what is torn down. `undefined` = no confirmation open.
  const [destroyWith, setDestroyWith] = useState<string | null | undefined>(undefined);

  const isManaged = runner.operator === "managed";
  const busy = runnerBusyKind(runner);
  const hasCloudResources = runner.in_place;
  // A destroy stays "Destroying…" from the click until the job it queued shows on the card.
  const destroying = destroy.isPending || destroy.isSuccess;

  /** Sets this runner as the org default, or clears the default when it already is. */
  const handleToggleDefault = () => {
    const newValue = !runner.is_default;
    setDefault.mutate(newValue ? runner.id : null, {
      onSuccess: () => {
        toast.success(newValue ? `${runner.name} set as default` : "Default runner cleared");
      },
    });
  };

  /** Queues the destroy job on the picked runner (null = any available). */
  const handleDestroy = (assignedRunnerId: string | null) => {
    destroy.mutate(
      { runnerId: runner.id, assignedRunnerId },
      {
        onSuccess: ({ jobId }) => {
          toast.success("Destroy job queued", {
            action: {
              label: "View job",
              onClick: () => router.push(globalHref(orgSlug, `jobs/${jobId}`)),
            },
          });
        },
      },
    );
  };

  // The removal the confirmation runs: it closes on success (with one toast) and stays open on a
  // failure, which `useActionMutation` has already reported.
  const confirmableRemove = {
    isPending: remove.isPending,
    mutate: (runnerId: string, options?: { onSuccess?: () => void; onSettled?: () => void }) => {
      remove.mutate(runnerId, {
        onSuccess: () => {
          toast.success(`${runner.name} removed`);
          options?.onSuccess?.();
        },
        onSettled: options?.onSettled,
      });
    },
  };

  if (busy && runner.active_job) {
    const label =
      busy === "DEPLOY_RUNNER"
        ? "Provisioning…"
        : busy === "UPDATE_RUNNER"
          ? "Updating…"
          : "Destroying…";
    return (
      <Link
        href={globalHref(orgSlug, `jobs/${runner.active_job.id}`)}
        onClick={(e) => e.stopPropagation()}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        {label}
      </Link>
    );
  }

  return (
    <div
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      {runner.personal_elsewhere ? (
        // A default is chosen per org, and this runner's org is the personal workspace: the star is
        // gated here, with the reason, rather than offered and then refused.
        <DisabledReason reason={PERSONAL_RUNNER_DEFAULT_REASON}>
          <button
            type="button"
            aria-label="Set as default runner"
            className="rounded p-1"
          >
            <Star className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </DisabledReason>
      ) : (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger
              render={
                // The tooltip is the only thing that named this control, and a tooltip
                // is not an accessible name — the star was an unlabelled icon button
                // that a spec could only reach positionally (`getByRole("button").first()`).
                // The label states the ACTION the click performs, so it flips with the
                // state the same way the tooltip does.
                <button
                  type="button"
                  aria-label={
                    runner.is_default ? "Clear default runner" : "Set as default runner"
                  }
                  onClick={handleToggleDefault}
                  disabled={setDefault.isPending}
                  className="rounded p-1 transition-colors hover:bg-muted"
                >
                  <Star
                    className={`h-3.5 w-3.5 ${runner.is_default ? "fill-foreground text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  />
                </button>
              }
            />
            <TooltipContent side="top" className="text-xs">
              {runner.is_default ? "Clear default" : "Set as default"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {!isManaged &&
        runner.provisioning === "deployed" &&
        hasCloudResources && (
          <>
            <RunnerSelectPopover
              trigger={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                  disabled={destroying}
                >
                  {destroying ? "Destroying…" : "Destroy"}
                </Button>
              }
              variant="destructive"
              title={`Destroy runner \u201C${runner.name}\u201D`}
              subtitle="Choose which runner carries out the destroy job."
              confirmLabel="Continue to destroy"
              excludeId={runner.id}
              onConfirm={(assignedRunnerId) => setDestroyWith(assignedRunnerId)}
              disabled={destroying}
            />
            <ConfirmAction
              open={destroyWith !== undefined}
              onOpenChange={(open) => {
                if (!open) setDestroyWith(undefined);
              }}
              title={`Destroy runner \u201C${runner.name}\u201D?`}
              description="The runner's cloud resources are torn down and the runner is deleted. This cannot be undone."
              confirmLabel="Destroy runner"
              pendingLabel="Queuing…"
              severity={{
                level: "destroy",
                subject: runner.name,
                consequences: RUNNER_DESTROY_CONSEQUENCES,
              }}
              run={() => {
                if (destroyWith === undefined) return false;
                handleDestroy(destroyWith);
                return true;
              }}
            />
          </>
        )}

      {!isManaged &&
        !(runner.provisioning === "deployed" && hasCloudResources) && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => setShowRemoveDialog(true)}
            >
              Remove
            </Button>

            <ConfirmAction
              open={showRemoveDialog}
              onOpenChange={setShowRemoveDialog}
              title={`Remove runner \u201C${runner.name}\u201D?`}
              description="The runner is removed from this list and is no longer given jobs. The machine it runs on is not touched. This cannot be undone."
              confirmLabel="Remove"
              pendingLabel="Removing…"
              severity={{ level: "confirm" }}
              mutation={confirmableRemove}
              variables={showRemoveDialog ? runner.id : null}
            />
          </>
        )}
    </div>
  );
}
