"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@repo/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import {
  CheckCircle2,
  ChevronDown,
  Loader2,
  RotateCcw,
  XCircle,
} from "lucide-react";
import {
  closeCase,
  reopenCase,
  resolveCase,
} from "@/app/server/actions/support";
import type { ActionResult } from "@/lib/actions/result";
import { useActionMutation } from "@/lib/actions/use-action-mutation";
import type { SupportCaseStatus } from "@/lib/db/schema/enums";
import { supportCaseKeys } from "./case-queries";

/** The lifecycle actions available on a case, resolved from its current status. */
type CaseAction = "resolve" | "reopen" | "close";

/** Maps each status to the transitions a customer may perform from it. */
const AVAILABLE_ACTIONS: Record<SupportCaseStatus, CaseAction[]> = {
  open: ["resolve", "close"],
  pending_support: ["resolve", "close"],
  pending_customer: ["resolve", "close"],
  resolved: ["reopen", "close"],
  closed: ["reopen"],
};

/** The server action, menu label and confirmation for each lifecycle transition. */
const ACTION_META: Record<
  CaseAction,
  {
    label: string;
    done: string;
    run: (input: { id: string }) => Promise<ActionResult<{ id: string }>>;
    icon: typeof CheckCircle2;
  }
> = {
  resolve: { label: "Mark resolved", done: "Case marked resolved", run: resolveCase, icon: CheckCircle2 },
  reopen: { label: "Reopen case", done: "Case reopened", run: reopenCase, icon: RotateCcw },
  close: { label: "Close case", done: "Case closed", run: closeCase, icon: XCircle },
};

/**
 * The status-transition control for a case. Presents only the transitions valid for the current
 * status. Each goes through the mutation contract (`useActionMutation`): the control is disabled
 * while one is in flight (the double-submit guard), a refusal — the case moved under you — is a
 * readable toast, and on settle it invalidates every key that shows a case: the case view, every
 * "My cases" bucket and the shell's bell feed, so the badge, the buckets and the bell move together.
 *
 * `variant="reopen"` is the closed-case notice's single button: a closed case's only way forward.
 */
export function CaseActions({
  caseId,
  status,
  variant = "menu",
}: {
  caseId: string;
  status: SupportCaseStatus;
  variant?: "menu" | "reopen";
}) {
  const mutation = useActionMutation(
    async (action: CaseAction): Promise<ActionResult<{ action: CaseAction }>> => {
      const result = await ACTION_META[action].run({ id: caseId });
      return result.ok ? { ok: true, data: { action } } : result;
    },
    {
      invalidates: supportCaseKeys(),
      successMessage: ({ action }) => ACTION_META[action].done,
    },
  );

  if (variant === "reopen") {
    return (
      <Button
        size="sm"
        variant="outline"
        className="mt-1"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate("reopen")}
      >
        {mutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
        Reopen case
      </Button>
    );
  }

  const actions = AVAILABLE_ACTIONS[status];
  if (actions.length === 0) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" disabled={mutation.isPending}>
            {mutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            Actions
            <ChevronDown className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {actions.map((action) => {
          const { label, icon: Icon } = ACTION_META[action];
          return (
            <DropdownMenuItem
              key={action}
              onSelect={() => mutation.mutate(action)}
            >
              <Icon className="size-4" />
              {label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
