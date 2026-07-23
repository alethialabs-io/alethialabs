"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui-components/react/select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { cn } from "./utils";

/**
 * value → label(node) map. base-ui's `Select.Value` renders the raw selected *value* on the (closed)
 * trigger, not the chosen item's label — unless the Root gets an `items` map. We build that map
 * EAGERLY from the `SelectItem` children (see `Select` below) so the trigger shows the label on first
 * render with no flicker, and expose it via context so `SelectValue` can also drive the placeholder.
 */
const SelectItemsContext = React.createContext<Record<string, React.ReactNode>>(
  {},
);

/** Recursively collect `value → children(label)` from the `SelectItem` descendants of `node`
 * (walking through SelectContent / SelectGroup / arrays / fragments). Eager — runs at render. */
function collectSelectItems(
  node: React.ReactNode,
  acc: Record<string, React.ReactNode>,
): void {
  React.Children.forEach(node, (child) => {
    if (!React.isValidElement(child)) return;
    if (child.type === SelectItem) {
      const p = child.props as { value?: unknown; children?: React.ReactNode };
      if (p.value != null) acc[String(p.value)] = p.children;
      return;
    }
    const kids = (child.props as { children?: React.ReactNode })?.children;
    if (kids != null) collectSelectItems(kids, acc);
  });
}

/** Grayscale/squared select over the base-ui `Select` primitive. Builds the value→label `items` map
 * from its `SelectItem` children so the trigger resolves labels (not raw values).
 *
 * Exposes a STABLE single-select string surface for `value`/`defaultValue`/`onValueChange` instead of
 * base-ui's raw generic (which types the value as `unknown` and would ripple type errors into every
 * `onValueChange={setState}` call site). */
function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  ...props
}: Omit<
  React.ComponentProps<typeof SelectPrimitive.Root>,
  "value" | "defaultValue" | "onValueChange"
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}) {
  const items = React.useMemo(() => {
    const acc: Record<string, React.ReactNode> = {};
    collectSelectItems(children, acc);
    return acc;
  }, [children]);
  return (
    <SelectItemsContext.Provider value={items}>
      <SelectPrimitive.Root
        data-slot="select"
        items={items}
        value={value}
        defaultValue={defaultValue}
        onValueChange={
          onValueChange
            ? (v) => onValueChange(v == null ? "" : String(v))
            : undefined
        }
        {...props}
      >
        {children}
      </SelectPrimitive.Root>
    </SelectItemsContext.Provider>
  );
}

function SelectGroup({
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

/** The trigger's selected-value display. Resolves the selected value to its item label via the
 * items context (so `<SelectItem value={id}>{name}</SelectItem>` shows `name`), and renders the
 * `placeholder` when nothing is selected. */
function SelectValue({
  className,
  placeholder,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Value>, "children"> & {
  placeholder?: React.ReactNode;
}) {
  const items = React.useContext(SelectItemsContext);
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={className}
      {...props}
    >
      {(value: unknown) => {
        const empty =
          value == null ||
          value === "" ||
          (Array.isArray(value) && value.length === 0);
        if (empty) return placeholder;
        const resolve = (v: unknown) => items[String(v)] ?? String(v);
        return Array.isArray(value) ? (
          <>{value.map((v) => resolve(v))}</>
        ) : (
          resolve(value)
        );
      }}
    </SelectPrimitive.Value>
  );
}

function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex w-fit items-center justify-between gap-2 rounded-none border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<ChevronDownIcon className="size-4 opacity-50" />}
      />
    </SelectPrimitive.Trigger>
  );
}

/** The floating list panel. Radix `Portal > Content` → base-ui `Portal > Positioner > Popup > List`;
 * `--radix-select-*` CSS vars → base-ui `--available-height`/`--anchor-width`/`--transform-origin`;
 * `data-[state=open|closed]` → `data-[open]`/`data-[closed]`. `alignItemWithTrigger={false}` reproduces
 * Radix's `position="popper"` (list below the trigger, not overlaying it). */
function SelectContent({
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof SelectPrimitive.Popup>, "children"> & {
  children?: React.ReactNode;
  side?: React.ComponentProps<typeof SelectPrimitive.Positioner>["side"];
  sideOffset?: React.ComponentProps<
    typeof SelectPrimitive.Positioner
  >["sideOffset"];
  align?: React.ComponentProps<typeof SelectPrimitive.Positioner>["align"];
}) {
  const { side, sideOffset = 4, align, ...popupProps } = props;
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignItemWithTrigger={false}
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            "bg-popover text-popover-foreground data-[open]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[open]:fade-in-0 data-[closed]:zoom-out-95 data-[open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-[var(--available-height)] min-w-[8rem] origin-[var(--transform-origin)] overflow-x-hidden overflow-y-auto rounded-md border shadow-md",
            className,
          )}
          {...popupProps}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="w-full min-w-[var(--anchor-width)] scroll-my-1 p-1">
            {children}
          </SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

/** A standalone list heading. base-ui `Select.GroupLabel` must live inside a `Select.Group`, but
 * Radix's `SelectLabel` was free-standing, so this renders a plain styled `<div>`. */
function SelectLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="select-label"
      className={cn("text-muted-foreground px-2 py-1.5 text-xs", className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("bg-border pointer-events-none -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpArrow>) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className,
      )}
      {...props}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownArrow>) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        "flex cursor-default items-center justify-center py-1",
        className,
      )}
      {...props}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
