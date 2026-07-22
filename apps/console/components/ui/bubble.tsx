"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Vendored from the shadcn registry (`bubble`, new-york-v4). A chat bubble whose skin is
// driven by `variant` (grayscale tokens in this system). Imports rewired to `@repo/ui/*`.
// The transcript uses `variant="secondary"` for the user's turns (assistant turns render
// bare, no bubble).

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { mergeProps } from "@base-ui-components/react/merge-props";
import { useRender } from "@base-ui-components/react/use-render";
import { cn } from "@repo/ui/utils";

const bubbleVariants = cva(
  "group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end data-[variant=ghost]:max-w-full",
  {
    variants: {
      variant: {
        default:
          "*:data-[slot=bubble-content]:bg-primary *:data-[slot=bubble-content]:text-primary-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-primary/80",
        secondary:
          "*:data-[slot=bubble-content]:bg-secondary *:data-[slot=bubble-content]:text-secondary-foreground [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]",
        muted:
          "*:data-[slot=bubble-content]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]",
        outline:
          "*:data-[slot=bubble-content]:border-border *:data-[slot=bubble-content]:bg-background [&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground",
        ghost:
          "border-none *:data-[slot=bubble-content]:rounded-none *:data-[slot=bubble-content]:bg-transparent *:data-[slot=bubble-content]:p-0 [&>[data-slot=bubble-content]:is(button,a):hover]:bg-muted [&>[data-slot=bubble-content]:is(button,a):hover]:text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

/** A chat bubble wrapper — sets the content skin from `variant`, end-aligns for the user. */
function Bubble({
  variant = "default",
  align = "start",
  className,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof bubbleVariants> & {
    align?: "start" | "end";
  }) {
  return (
    <div
      data-slot="bubble"
      data-variant={variant}
      data-align={align}
      className={cn(bubbleVariants({ variant }), className)}
      {...props}
    />
  );
}

/** The bubble body (the skinned box). `asChild` renders it as its single child (e.g. a button) —
 * migrated off Radix `Slot` to base-ui `useRender` (the same merge-onto-my-child behavior). */
function BubbleContent({
  asChild = false,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  asChild?: boolean;
}) {
  const useAsChild = asChild && React.isValidElement(children);
  // `data-slot` sits in a typed object so React 19's excess-property check accepts the data-attr
  // (a bare literal of div props rejects `data-*`).
  const ownProps: React.ComponentProps<"div"> & { "data-slot": string } = {
    "data-slot": "bubble-content",
    className: cn(
      "w-fit max-w-full min-w-0 overflow-hidden rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed wrap-break-word group-data-[align=end]/bubble:self-end",
      className,
    ),
    ...(useAsChild ? {} : { children }),
  };
  return useRender({
    render: useAsChild ? children : <div />,
    props: mergeProps<"div">(ownProps, props),
  });
}

export { Bubble, BubbleContent, bubbleVariants };
