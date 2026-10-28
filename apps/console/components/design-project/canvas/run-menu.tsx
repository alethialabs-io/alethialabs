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

/**
 * The Run menu — every job the platform can run against an environment, from the board.
 *
 * `provision_job_type` has thirteen values, and the canvas offered two: Deploy and Destroy. AUDIT,
 * DETECT_DRIFT and PROBE_CLUSTER all existed, all had runner-side executors, and two of them even
 * ran on a schedule — you just couldn't ask for one. Now you can.
 *
 * Each item is one `useActionMutation` (ADR 0005 §D4, #6119): a refusal the user can act on ("no
 * cloud account linked", "run a plan first", "a probe is already running") is a `conflict` whose
 * sentence is shown verbatim — never a digest — and a queued job invalidates the environment's
 * status and job history, so this tab shows its own job at once (other tabs hear the `jobs` hint).
 * The trigger is disabled while any of them is in flight: the double-submit guard.
 */
export function RunMenu({
  projectId,
  environmentId,
}: {
  projectId: string;
  environmentId: string;
}) {
  const options = (label: string) => ({
    invalidates: [orpc.canvas.environmentJobs.key(), orpc.canvas.environmentStatus.key()],
    successMessage: `${label} queued`,
  });
  const plan = useActionMutation(planEnvironmentAction, options("Plan"));
  const audit = useActionMutation(queueEnvironmentAuditAction, options("Audit"));
  const drift = useActionMutation(detectDriftAction, options("Drift detection"));
  const probe = useActionMutation(queueClusterProbeAction, options("Cluster probe"));
  const running = plan.isPending || audit.isPending || drift.isPending || probe.isPending;
  const target = { projectId, environmentId };

  /** Queue one job — unless one is already being queued from this menu. */
  const run = (mutation: { mutate: (input: typeof target) => void }) => {
    if (running) return;
    mutation.mutate(target);
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
            disabled={running}
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
          onSelect={() => run(plan)}
        >
          <SquareCheck className="mr-2 h-4 w-4 text-muted-foreground" />
          <span className="flex-1">Plan</span>
          <span className="vx-eyebrow text-ui-3xs">PLAN</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() => run(audit)}
        >
          <ShieldCheck className="mr-2 h-4 w-4 text-muted-foreground" />
          <span className="flex-1">Audit</span>
          <span className="vx-eyebrow text-ui-3xs">AUDIT</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() => run(drift)}
        >
          <RefreshCw className="mr-2 h-4 w-4 text-muted-foreground" />
          <span className="flex-1">Detect drift</span>
          <span className="vx-eyebrow text-ui-3xs">DRIFT</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={() => run(probe)}
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
