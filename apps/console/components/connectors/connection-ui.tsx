"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Badge } from "@repo/ui/badge";
import { Button } from "@repo/ui/button";
import { FieldHelp } from "@repo/ui/field-help";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";
import { Separator } from "@repo/ui/separator";
import { StatusBadge, type StatusTier } from "@repo/ui/status-badge";
import { cn } from "@repo/ui/utils";
import {
  HelpCircle,
  KeyRound,
  Lock,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ConnTestState } from "./use-connection-test";

// Design system: grayscale, hairline borders, no shadowed cards, no colored status fills.
// Status is a dot/icon + label, never hue. Mirrors components/connectors/connector-detail-sheet.tsx.

type CalloutVariant = "success" | "pending" | "error";

/**
 * The callout's three states, resolved to the ONE status vocabulary the product has.
 *
 * This was a `Record<CalloutVariant, ReactNode>` of three lucide icons — a check, a spinner and a
 * cross — which made the callout a second rendering of states the rest of the console already
 * draws: a pending connection test showed a spinner here and a hollow dot in every table. A
 * `Record<YourStatus, StatusTier>` handed to `<StatusBadge tier>` is what `statusTier()`'s own doc
 * requires for a vocabulary the shared map does not know, so the mark comes from the badge and the
 * words stay the caller's.
 *
 * `pending` takes the `live` tier rather than the shared map's `pending`: a verify in flight is
 * the one thing on this surface that is genuinely still happening, and `live` is the tier that
 * breathes. The other two resolve the way the shared map already resolves those words.
 */
const VARIANT_TIER: Record<CalloutVariant, StatusTier> = {
  success: "active",
  pending: "live",
  error: "failed",
};

/**
 * The status banner shown while saving / after a verification attempt. Hairline row,
 * grayscale — the state reads from the shared status dot + title, not a colored fill.
 * Shared across every provider connection component so the states look identical everywhere.
 *
 * It is a live region, so the outcome of a press is announced where it appears: a failure as an
 * alert, the other two politely as a status (B-05). `action` sits at the row's end — the Cancel of
 * a verify in flight.
 */
export function StatusCallout({
  variant,
  title,
  children,
  action,
}: {
  variant: CalloutVariant;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-3 rounded-md border border-border/60 bg-muted/20 p-3.5",
        variant === "error" ? "items-start" : "items-center",
      )}
    >
      <StatusBadge
        status={variant}
        tier={VARIANT_TIER[variant]}
        showLabel={false}
        className={cn("shrink-0", variant === "error" && "mt-0.5")}
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground text-sm">{title}</p>
        <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">
          {children}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * Where a connect press stands, said once in one place under the form: verifying (with a Cancel,
 * so the flow can never get stuck), verified — a fully CONNECTED account or a DEGRADED one
 * (authenticated, but missing some provisioning permissions) — or failed with the provider's
 * reason. Nothing for a form that has not been sent.
 */
export function ConnectStatus({
  state,
  successText,
  verifyingText,
  onCancel,
}: {
  state: ConnTestState;
  successText: string;
  verifyingText: string;
  onCancel: () => void;
}) {
  if (state.phase === "success") {
    if (state.status === "degraded") {
      const missing = state.missingPermissions?.length
        ? ` (${state.missingPermissions.join(", ")})`
        : "";
      return (
        <StatusCallout variant="pending" title="Connected — limited permissions">
          {successText} Some provisioning permissions look missing{missing} —
          provisioning may fail until the role is widened.
        </StatusCallout>
      );
    }
    return (
      <StatusCallout variant="success" title="Connection verified">
        {successText}
      </StatusCallout>
    );
  }
  if (state.phase === "saving") {
    return (
      <StatusCallout
        variant="pending"
        title="Verifying connection…"
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 border-border/60 text-xs"
            onClick={onCancel}
          >
            Cancel
          </Button>
        }
      >
        {verifyingText}
      </StatusCallout>
    );
  }
  if (state.phase === "failed") {
    return (
      <StatusCallout variant="error" title="Verification failed">
        {state.error}
      </StatusCallout>
    );
  }
  return null;
}

/** The muted "how your credentials are handled" footnote. Shared. */
export function InfoNote({ children }: { children: ReactNode }) {
  return (
    <p className="text-ui-xs text-muted-foreground leading-relaxed">
      {children}
    </p>
  );
}

/**
 * The "How this works" popover — a quiet labelled trigger that opens a plain-language explanation of
 * the keyless trust model. Reassures a non-expert user before they touch their cloud console.
 */
function HowItWorks({ children }: { children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-sm text-ui-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <HelpCircle className="size-3.5" />
            How this works
          </button>
        }
      />
      <PopoverContent side="bottom" align="end" className="w-80 p-3.5">
        <p className="mb-1.5 font-medium text-foreground text-xs">
          How this works
        </p>
        <div className="space-y-1.5 text-muted-foreground text-xs leading-relaxed">
          {children}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The shared connect-sheet frame. The Sheet header (ConnectSheetHeader) already carries the provider
 * name + icon, so this renders only a lead-in — a keyless/encrypted badge, the one-line intro, and a
 * quiet "How this works" — a hairline rule, then the provider-specific body. No card, no shadow: flat
 * hairline sections in the grayscale system. Self-contained so it also works in the create-project flow.
 */
export function ConnectSheetShell({
  title,
  intro,
  howItWorks,
  badgeLabel = "Keyless",
  children,
}: {
  /** Retained for API compatibility; the Sheet header shows the title, so it's not repeated here. */
  title?: string;
  intro: ReactNode;
  howItWorks: ReactNode;
  /** The reassurance pill — "Keyless" for the federated clouds, "Encrypted" for token clouds. */
  badgeLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <Badge
            variant="secondary"
            className="h-5 gap-1 px-1.5 font-medium text-ui-2xs"
          >
            <ShieldCheck className="size-3" />
            {badgeLabel}
          </Badge>
          <HowItWorks>{howItWorks}</HowItWorks>
        </div>
        <p className="text-muted-foreground text-sm leading-relaxed">{intro}</p>
      </div>
      <Separator />
      {children}
    </div>
  );
}

/** One method choice in {@link MethodTabs}. */
export interface MethodTab {
  id: string;
  label: string;
  sub: string;
  icon: ReactNode;
}

/**
 * The setup-method selector (e.g. CloudFormation vs Terraform) — a compact segmented control with a
 * "?" popover explaining how to choose. Replaces the two oversized bordered cards. The chosen
 * method is said by `aria-pressed`, not by its fill alone (B-05).
 */
export function MethodTabs({
  tabs,
  value,
  onChange,
  help,
  label = "Choose a setup method",
}: {
  tabs: MethodTab[];
  value: string;
  onChange: (id: string) => void;
  help?: ReactNode;
  label?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className="font-semibold text-ui-xs text-muted-foreground uppercase tracking-wider">
          {label}
        </span>
        {help && <FieldHelp title={label}>{help}</FieldHelp>}
      </div>
      <div role="group" aria-label={label} className="inline-flex rounded-md border border-border/60 p-0.5">
        {tabs.map((t) => {
          const active = value === t.id;
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(t.id)}
              className={cn(
                "flex items-center gap-1.5 rounded px-3 py-1.5 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.icon}
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A numbered setup step. Flat hairline chip + title + body. Shared across every connect sheet. */
export function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex gap-3.5">
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 font-medium text-ui-xs text-muted-foreground">
        {n}
      </div>
      <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
        <div className="font-medium text-foreground text-sm">{title}</div>
        {children}
      </div>
    </div>
  );
}

/**
 * The reassurance footer: exactly what Alethia keeps, and how to cut access. One subtle inset so the
 * "we store almost nothing" promise reads consistently.
 */
export function StoredNote({
  stored,
  revoke,
}: {
  stored: ReactNode;
  revoke: ReactNode;
}) {
  return (
    <div className="grid gap-2 rounded-md border border-border/40 bg-muted/20 p-3 text-ui-xs text-muted-foreground">
      <div className="flex items-start gap-2">
        <Lock className="mt-0.5 size-3.5 shrink-0" />
        <p className="leading-relaxed">
          <span className="font-medium text-foreground">
            What&apos;s stored:{" "}
          </span>
          {stored}
        </p>
      </div>
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-3.5 shrink-0" />
        <p className="leading-relaxed">
          <span className="font-medium text-foreground">Revoke anytime: </span>
          {revoke}
        </p>
      </div>
    </div>
  );
}
