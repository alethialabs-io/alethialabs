"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
  Activity,
  Play,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  SquareCheck,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@repo/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import {
  queueClusterProbe,
  queueEnvironmentAudit,
} from "@/app/server/actions/canvas-jobs";
import {
  tryPlanProject,
  tryQueueDriftDetection,
} from "@/app/server/actions/projects";

/**
 * The sentence of a refusal an action RETURNED (`{ ok: false, error }`), or null for any other
 * result. Plan and drift answer this way (#5445): their refusals used to be thrown, and a production
 * build replaced each with a digest before this menu's toast could show it.
 */
function refusalOf(result: unknown): string | null {
  if (
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === false &&
    "error" in result &&
    typeof result.error === "string"
  ) {
    return result.error;
  }
  return null;
}

/**
 * The Run menu — every job the platform can run against an environment, from the board.
 *
 * `provision_job_type` has thirteen values, and the canvas offered two: Deploy and Destroy. AUDIT,
 * DETECT_DRIFT and PROBE_CLUSTER all existed, all had runner-side executors, and two of them even
 * ran on a schedule — you just couldn't ask for one. Now you can.
 */
export function RunMenu({
  projectId,
  environmentId,
  onQueued,
}: {
  projectId: string;
  environmentId: string;
  onQueued?: () => void;
}) {
  const [running, setRunning] = useState<string | null>(null);

  /** Queue a job, and say what happened either way. A silent failure here is a lie about the env. */
  const run = async (
    label: string,
    fn: () => Promise<{ jobId: string } | unknown>,
  ) => {
    setRunning(label);
    try {
      const refusal = refusalOf(await fn());
      if (refusal) {
        // A refusal the user can act on ("no cloud account linked", "a job is already in
        // progress"), returned as a value so its sentence survives a production build.
        toast.error(refusal);
        return;
      }
      toast.success(`${label} queued`);
      onQueued?.();
    } catch (e) {
      // Anything still THROWN is either an action that has not moved to returned refusals yet
      // (audit, probe) or an unexpected failure, whose message a production build redacts.
      toast.error(e instanceof Error ? e.message : `Could not queue ${label}`);
    } finally {
      setRunning(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={!!running}
          >
            <Play className="mr-1 h-3.5 w-3.5" />
            Run
          </Button>
        }
      />

      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="vx-eyebrow">
          Run on this environment
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={() =>
            void run("Plan", () => tryPlanProject(projectId, null, environmentId))
          }
        >
          <SquareCheck className="mr-2 h-4 w-4 text-muted-foreground" />
          <span className="flex-1">Plan</span>
          <span className="vx-eyebrow text-ui-3xs">PLAN</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() =>
            void run("Audit", () =>
              queueEnvironmentAudit(projectId, environmentId),
            )
          }
        >
          <ShieldCheck className="mr-2 h-4 w-4 text-muted-foreground" />
          <span className="flex-1">Audit</span>
          <span className="vx-eyebrow text-ui-3xs">AUDIT</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() =>
            void run("Drift detection", () =>
              tryQueueDriftDetection(projectId, environmentId),
            )
          }
        >
          <RefreshCw className="mr-2 h-4 w-4 text-muted-foreground" />
          <span className="flex-1">Detect drift</span>
          <span className="vx-eyebrow text-ui-3xs">DRIFT</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() =>
            void run("Cluster probe", () =>
              queueClusterProbe(projectId, environmentId),
            )
          }
        >
          <Activity className="mr-2 h-4 w-4 text-muted-foreground" />
          <span className="flex-1">Probe cluster</span>
          <span className="vx-eyebrow text-ui-3xs">PROBE</span>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-ui-xs font-normal text-muted-foreground">
          <ScanSearch className="mr-1 inline h-3 w-3" />
          Chart and IaC rescans live on their own cards.
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
