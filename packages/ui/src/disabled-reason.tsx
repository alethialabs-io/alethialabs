"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/*
 * A control that cannot be used right now, and SAYS WHY — to a pointer, a keyboard and a screen
 * reader alike.
 *
 * Why this exists (#4996, review of #5000). The console's "gated rather than hidden" rule (the WAF
 * switch in the inspector: a switch that silently is not there reads as a bug, one that says why is
 * an answer) was first applied to buttons as `disabled` + `title`. That reason reached nobody:
 *   - `Button` carries `disabled:pointer-events-none`, so a disabled button never receives the hover
 *     that would show its `title`;
 *   - a natively disabled `<button>` is not focusable, so a keyboard user can never land on it;
 *   - menu and command items carry `data-[disabled]:pointer-events-none` for the same reason.
 *
 * So the reason lives OUTSIDE the disabled element:
 *   - `DisabledReason` wraps a control in a focusable element that is the tooltip's trigger (hover
 *     AND keyboard focus open it), and points the control's and the wrapper's `aria-describedby` at a
 *     hidden copy of the reason, so a screen reader announces it on focus and in browse mode;
 *   - menu and command items cannot host a hover tooltip reliably (the item IS the hover target, and
 *     the menu closes around it), so they render the reason as visible secondary text in the item —
 *     the `disabledReason` prop on `ContextMenuItem`, `DropdownMenuItem` and `CommandItem`, built on
 *     `DisabledReasonItemBody` below — again referenced by `aria-describedby`.
 *
 * In both shapes the control keeps its disabled semantics (`disabled` / `aria-disabled`) and never
 * fires its handler. Passing no reason renders the control untouched, so a call site writes the
 * gate once: `reason={enabled ? null : WHY}`.
 */

import * as React from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";
import { cn } from "./utils";

/** The props a control must accept for `DisabledReason` to disable it and describe it. */
interface GateableProps {
  disabled?: boolean;
  "aria-describedby"?: string;
}

/** Joins two `aria-describedby` id lists, either of which may be absent. */
export function joinDescribedBy(
  existing: string | undefined,
  added: string,
): string {
  return existing ? `${existing} ${added}` : added;
}

interface DisabledReasonProps {
  /** Why the control cannot be used. Empty, `null` or `undefined`: the control is live and rendered untouched. */
  reason: string | null | undefined;
  /** The control. It is rendered `disabled` while there is a reason. */
  children: React.ReactElement<GateableProps>;
  /** Classes for the focusable wrapper (e.g. to size it like the control it holds). */
  className?: string;
}

/**
 * Renders `children` disabled, inside a focusable wrapper whose tooltip — on hover and on keyboard
 * focus — and whose `aria-describedby` both carry `reason`. With no reason, renders `children` as is.
 */
function DisabledReason({ reason, children, className }: DisabledReasonProps) {
  const reasonId = React.useId();
  if (!reason) return children;
  const control = React.cloneElement(children, {
    disabled: true,
    "aria-describedby": joinDescribedBy(
      children.props["aria-describedby"],
      reasonId,
    ),
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-slot="disabled-reason"
            // Focusable ON PURPOSE: the disabled control inside is not, and this is how a keyboard
            // user reaches the reason at all.
            tabIndex={0}
            aria-describedby={reasonId}
            className={cn(
              "inline-flex cursor-not-allowed rounded-none outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              className,
            )}
          />
        }
      >
        {control}
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
      {/* Outside the wrapper, so focusing it announces the reason ONCE (as its description) rather
          than again as part of its content. The tooltip popup is not referenced: it exists only
          while open, and an id that resolves only sometimes is not a description.
          `hidden`, NOT `sr-only`: `aria-describedby` reads a hidden node's text all the same, and
          `sr-only` is `position: absolute` against the nearest positioned ancestor — with none, the
          viewport — so a copy placed below the fold inside the shell's scrolling <main> grew the
          DOCUMENT's scroll height and gave `~/settings/general` a second scroll container (R3,
          release-gate run 35915058781). */}
      <span id={reasonId} hidden>
        {reason}
      </span>
    </Tooltip>
  );
}

/**
 * The inside of a disabled menu or command item: its own content dimmed, then the reason as
 * visible secondary text at full strength, carrying `id` so the item's `aria-describedby` can
 * point at it. The item itself must stop dimming (its own `data-[disabled]:opacity-50`), or the
 * reason would be dimmed with it; each item primitive overrides that when it carries a reason.
 */
function DisabledReasonItemBody({
  id,
  reason,
  children,
}: {
  id: string;
  reason: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <span
        data-slot="disabled-reason-label"
        className="flex min-w-0 items-center gap-2 opacity-50"
      >
        {children}
      </span>
      {/* `aria-hidden` keeps the item's NAME its label; the reason still reaches a screen reader as
          the item's DESCRIPTION, because `aria-describedby` reads a hidden node's text. */}
      <span
        id={id}
        aria-hidden="true"
        data-slot="disabled-reason-text"
        className="ml-auto pl-4 text-xs text-muted-foreground"
      >
        {reason}
      </span>
    </>
  );
}

export { DisabledReason, DisabledReasonItemBody };
export type { DisabledReasonProps };
