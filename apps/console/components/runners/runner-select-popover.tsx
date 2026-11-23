"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useRunnersQuery } from "@/lib/query/use-runners-query";
import { globalHref } from "@/lib/routing";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { StatusBadge } from "@repo/ui/status-badge";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { Skeleton } from "@repo/ui/skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/tooltip";
import { Check, Server } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { cn } from "@repo/ui/utils";

interface RunnerSelectPopoverProps {
  trigger: React.ReactElement<Record<string, unknown>>;
  onConfirm: (runnerId: string | null, rePlan?: boolean) => void;
  disabled?: boolean;
  showRePlan?: boolean;
  variant?: "default" | "destructive";
  confirmLabel?: string;
  /** The popover's heading; names the action when the pick is a step of one (e.g. a destroy). */
  title?: string;
  /** The line under the heading. */
  subtitle?: string;
  excludeId?: string;
}

/** A runner's heartbeat status as a word a person reads, not the backend's enum. */
function statusWord(status: string): string {
  if (status === "ONLINE") return "Online";
  if (status === "DRAINING") return "Draining";
  return "Offline";
}

/**
 * Why Confirm is not available, or null when it is.
 *
 * The question is about the org's WHOLE runner set, not the list this picker shows: a destroy
 * excludes the runner being destroyed from its choices, and that runner still exists to be acted
 * on. An org with no runner at all has nothing that could ever claim the job, so the job is not
 * sent; a read that has not answered (or failed) is not taken to mean "none".
 */
export function runnerPickerConfirmReason(read: { isError: boolean; runnerCount: number | null }): string | null {
  if (read.runnerCount === null) {
    return read.isError ? "We couldn't load your runners." : "Loading runners…";
  }
  if (read.runnerCount === 0) return "No runner is registered to run this job.";
  return null;
}

/** Popover that shows before Plan/Deploy — lets the user pick a runner or "Any available". */
export function RunnerSelectPopover({
  trigger,
  onConfirm,
  disabled,
  showRePlan,
  variant = "default",
  confirmLabel,
  title = "Select runner",
  subtitle = "Choose which runner runs this job.",
  excludeId,
}: RunnerSelectPopoverProps) {
  // Live through the `runners` topic, so opening the popover needs no refetch of its own.
  const { data: runnersData, isError, refetch } = useRunnersQuery();
  const orgSlug = useActiveOrgSlug();
  const headingId = useId();
  const subtitleId = useId();
  const runners = useMemo(() => {
    const allRunners = runnersData?.runners ?? [];
    return excludeId ? allRunners.filter((t) => t.id !== excludeId) : allRunners;
  }, [runnersData, excludeId]);
  const runnerCount = runnersData ? runnersData.runners.length : null;
  const confirmReason = runnerPickerConfirmReason({ isError, runnerCount });
  const [open, setOpen] = useState(false);
  // What the user picked since the popover last opened; `undefined` until they pick. The selection
  // is derived on every render: the pick while it is still selectable ("Any available", or a runner
  // still in the list and ONLINE), otherwise the online default (or "Any available"). So a live
  // refresh keeps a pick that is still valid, a pick whose runner went offline or away falls back
  // rather than confirming a disabled runner, and a default that arrives after opening is used.
  const [picked, setSelected] = useState<string | null | undefined>(undefined);
  const defaultRunner = runners.find((w) => w.is_default && w.status === "ONLINE");
  const pickStillValid =
    picked === null ||
    (picked !== undefined && runners.some((w) => w.id === picked && w.status === "ONLINE"));
  const selected = pickStillValid ? picked : (defaultRunner?.id ?? null);
  const [rePlan, setRePlan] = useState(false);

  /** Opening starts from the default again; closing keeps nothing to reset. */
  const handleOpenChange = (next: boolean) => {
    if (next) setSelected(undefined);
    setOpen(next);
  };

  const handleConfirm = () => {
    if (confirmReason) return;
    setOpen(false);
    onConfirm(selected, rePlan);
    setRePlan(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger disabled={disabled} render={trigger} />
      <PopoverContent align="end" className="w-72 p-0">
        <div className="px-3 pt-3 pb-2 border-b border-border">
          <p id={headingId} className="text-sm font-medium">{title}</p>
          <p id={subtitleId} className="text-xs text-muted-foreground">
            {subtitle}
          </p>
        </div>

        {runnerCount === null && isError ? (
          <div role="alert" className="space-y-2 px-3 py-4 text-xs text-muted-foreground">
            <p>We couldn&rsquo;t load your runners, so this job can&rsquo;t be sent yet.</p>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        ) : runnerCount === null ? (
          <SkeletonRoot className="space-y-2 px-3 py-3">
            <span className="sr-only">Loading runners</span>
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </SkeletonRoot>
        ) : runnerCount === 0 ? (
          <div className="space-y-2 px-3 py-4 text-xs text-muted-foreground">
            <p>No runner is registered yet, so nothing could pick this job up.</p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              nativeButton={false}
              render={<Link href={globalHref(orgSlug, "runners")} />}
              onClick={() => setOpen(false)}
            >
              Register a runner
            </Button>
          </div>
        ) : (
          // One choice from a set: a radio group, so the picker has a name and each option says
          // whether it is the one selected (it was a column of unnamed buttons with a check icon).
          // Named "Select runner" whatever the heading says (a destroy's heading names the runner
          // being destroyed, not the choice), and described by the line that explains the choice.
          <div
            role="radiogroup"
            aria-label="Select runner"
            aria-describedby={subtitleId}
            className="max-h-52 overflow-y-auto py-1"
          >
            <button
              type="button"
              role="radio"
              aria-checked={selected === null}
              className={cn(
                "flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors focus-visible:outline-none focus-visible:bg-accent",
                selected === null && "bg-accent/50",
              )}
              onClick={() => setSelected(null)}
            >
              <div className="flex items-center justify-center h-4 w-4 shrink-0">
                {selected === null && <Check className="h-3.5 w-3.5" aria-hidden />}
              </div>
              <Server className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <span>Any available</span>
            </button>

            {runners.map((w) => {
              const status = w.status ?? "OFFLINE";
              const isOnline = status === "ONLINE";
              return (
                <button
                  key={w.id}
                  type="button"
                  role="radio"
                  aria-checked={selected === w.id}
                  disabled={!isOnline}
                  className={cn(
                    "flex items-center gap-2 w-full px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:bg-accent",
                    isOnline
                      ? "hover:bg-accent"
                      : "opacity-50 cursor-not-allowed",
                    selected === w.id && "bg-accent/50",
                  )}
                  onClick={() => isOnline && setSelected(w.id)}
                >
                  <div className="flex items-center justify-center h-4 w-4 shrink-0">
                    {selected === w.id && <Check className="h-3.5 w-3.5" aria-hidden />}
                  </div>
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <StatusBadge
                            status={status}
                            showLabel={false}
                            className="shrink-0"
                          />
                        }
                      />
                      <TooltipContent side="top" className="text-xs">
                        {statusWord(status)}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                  <span className="truncate flex-1">{w.name}</span>
                  <span className="sr-only">, {statusWord(status)}</span>
                  {w.is_default && (
                    <span className="text-ui-2xs text-muted-foreground font-medium uppercase tracking-wide">
                      Default
                    </span>
                  )}
                  <span className="text-ui-2xs text-muted-foreground">
                    {w.operator === "managed" ? "managed" : "self"}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="border-t border-border px-3 py-2 space-y-2">
          {showRePlan && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={rePlan}
                onChange={(e) => setRePlan(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border accent-primary"
              />
              <span className="text-xs text-muted-foreground">
                Re-plan before applying
              </span>
            </label>
          )}
          <DisabledReason reason={confirmReason} className="w-full">
            <Button
              size="sm"
              variant={variant === "destructive" ? "destructive" : "default"}
              className="w-full h-8 text-xs"
              onClick={handleConfirm}
            >
              {confirmLabel ?? "Confirm"}
            </Button>
          </DisabledReason>
        </div>
      </PopoverContent>
    </Popover>
  );
}
