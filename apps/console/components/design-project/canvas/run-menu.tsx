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
  type LucideIcon,
} from "lucide-react";
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
  queueClusterProbeAction,
  queueEnvironmentAuditAction,
} from "@/app/server/actions/canvas-jobs";
import {
  detectDriftAction,
  planEnvironmentAction,
} from "@/app/server/actions/canvas-writes";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import { orpc } from "@/lib/rpc/client";

/** One job the board can ask for: what it is called, its job-type mark, and how to queue it. */
interface RunJob {
  id: "plan" | "audit" | "drift" | "probe";
  label: string;
  /** The job type as the activity log prints it. */
  code: string;
  icon: LucideIcon;
  /** Queue the job — unless one is already being queued from the same set. */
  run: () => void;
}

/**
 * Every job the platform can run against an environment, ready to queue: four mutations with one
 * shared "is anything being queued" answer.
 *
 * Each job is one `useActionMutation` (ADR 0005 §D4, #6119): a refusal the user can act on ("no
 * cloud account linked", "run a plan first", "a probe is already running") is a `conflict` whose
 * sentence is shown verbatim — never a digest — and a queued job invalidates the environment's
 * status and job history, so this tab shows its own job at once (other tabs hear the `jobs` hint).
 */
function useRunJobs(target: { projectId: string; environmentId: string }): {
  jobs: RunJob[];
  running: boolean;
} {
  const options = (label: string) => ({
    invalidates: [orpc.canvas.environmentJobs.key(), orpc.canvas.environmentStatus.key()],
    successMessage: `${label} queued`,
  });
  const plan = useActionMutation(planEnvironmentAction, options("Plan"));
  const audit = useActionMutation(queueEnvironmentAuditAction, options("Audit"));
  const drift = useActionMutation(detectDriftAction, options("Drift detection"));
  const probe = useActionMutation(queueClusterProbeAction, options("Cluster probe"));
  const running = plan.isPending || audit.isPending || drift.isPending || probe.isPending;
  const { projectId, environmentId } = target;

  /** Queue one job — unless one is already being queued from this set. */
  const queue = (mutation: { mutate: (input: { projectId: string; environmentId: string }) => void }) => {
    if (running) return;
    mutation.mutate({ projectId, environmentId });
  };

  return {
    running,
    jobs: [
      { id: "plan", label: "Plan", code: "PLAN", icon: SquareCheck, run: () => queue(plan) },
      { id: "audit", label: "Audit", code: "AUDIT", icon: ShieldCheck, run: () => queue(audit) },
      { id: "drift", label: "Detect drift", code: "DRIFT", icon: RefreshCw, run: () => queue(drift) },
      { id: "probe", label: "Probe cluster", code: "PROBE", icon: Activity, run: () => queue(probe) },
    ],
  };
}

/**
 * The Run menu — every job the platform can run against an environment, from the board's toolbar.
 *
 * `provision_job_type` has thirteen values, and the canvas offered two: Deploy and Destroy. AUDIT,
 * DETECT_DRIFT and PROBE_CLUSTER all existed, all had runner-side executors, and two of them even
 * ran on a schedule — you just couldn't ask for one. Now you can.
 *
 * The jobs and their refusals are {@link useRunJobs}. The trigger is disabled while any of them is
 * in flight: the double-submit guard.
 */
export function RunMenu({
  projectId,
  environmentId,
}: {
  projectId: string;
  environmentId: string;
}) {
  const { jobs, running } = useRunJobs({ projectId, environmentId });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            data-tool=""
            variant="ghost"
            size="sm"
            className="h-8 rounded-none px-2 text-xs"
            // Busy, not gone: the menu comes back the moment the job is queued.
            aria-busy={running}
            disabled={running}
          >
            <Play className="mr-1 h-3.5 w-3.5" />
            Run
          </Button>
        }
      />

      <DropdownMenuContent align="center" className="w-60">
        <DropdownMenuLabel className="vx-eyebrow">
          Run on this environment
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {jobs.map((job) => {
          const Icon = job.icon;
          return (
            <DropdownMenuItem key={job.id} onSelect={job.run}>
              <Icon className="mr-2 h-4 w-4 text-muted-foreground" />
              <span className="flex-1">{job.label}</span>
              <span className="vx-eyebrow text-ui-3xs">{job.code}</span>
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-ui-xs font-normal text-muted-foreground">
          <ScanSearch className="mr-1 inline h-3 w-3" />
          Chart and IaC rescans live on their own cards.
        </DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
