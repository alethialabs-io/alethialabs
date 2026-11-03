"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ChevronDown } from "lucide-react";
import { useId } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@repo/ui/collapsible";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";
import {
  GROUP_CHEVRON_SIZE,
  GROUP_CLASS,
  GROUP_COUNT_CLASS,
  GROUP_LABEL_CLASS,
  GROUP_LABEL_ROW_CLASS,
  GROUP_ROWS_CLASS,
  GROUP_TRIGGER_CLASS,
  grantedInGroup,
  MATRIX_CLASS,
  PERMISSION_ACTION_CLASS,
  PERMISSION_GROUPS,
  PERMISSION_KEY_CLASS,
  PERMISSION_ROW_CLASS,
  permissionActionLabel,
} from "./roles-parts";

/**
 * Controlled permission picker (the chosen `resource:action` keys), grouped per
 * service. `readOnly` renders it as a disabled, view-only matrix (built-in roles).
 */
export function PermissionMatrix({
  value,
  onChange,
  readOnly,
}: {
  value: string[];
  onChange?: (keys: string[]) => void;
  readOnly?: boolean;
}) {
  const selected = new Set(value);
  const toggle = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    onChange?.([...next]);
  };

  return (
    // Each resource group is a collapsible section — collapsed by default so the whole
    // matrix stays compact; a "granted/total" badge keeps the selection visible while
    // closed, and groups with any grant open on mount so edits aren't hidden.
    <div className={MATRIX_CLASS}>
      {PERMISSION_GROUPS.map((g) => {
        const granted = grantedInGroup(g, selected);
        return (
          <Collapsible
            key={g.resource}
            defaultOpen={granted > 0}
            className={GROUP_CLASS}
          >
            <CollapsibleTrigger
              className={cn(
                "group transition-colors hover:bg-surface-muted",
                GROUP_TRIGGER_CLASS,
              )}
            >
              <span className={GROUP_LABEL_ROW_CLASS}>
                <span className={GROUP_LABEL_CLASS}>
                  {g.label}
                </span>
                <span
                  className={cn(
                    GROUP_COUNT_CLASS,
                    granted > 0
                      ? "border-border-strong text-text-secondary"
                      : "border-border text-text-tertiary",
                  )}
                >
                  {granted}/{g.permissions.length}
                </span>
              </span>
              <ChevronDown
                size={GROUP_CHEVRON_SIZE}
                className="shrink-0 text-text-tertiary transition-transform group-data-[panel-open]:rotate-180"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className={GROUP_ROWS_CLASS}>
                {g.permissions.map((p) => (
                  <PermissionRow
                    key={p.key}
                    permissionKey={p.key}
                    action={p.action}
                    checked={selected.has(p.key)}
                    readOnly={readOnly}
                    onToggle={toggle}
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}

/**
 * One permission row: the action, its key, and the toggle that grants it.
 *
 * ITS OWN COMPONENT BECAUSE OF THE HOOK. `useId` cannot be called inside the `.map()` callback
 * that used to render this inline, so the row is lifted out rather than the ids being generated
 * from `p.key` — a key like `project:create` is not guaranteed to be a valid, collision-free id
 * on a page that may render this matrix more than once (the role sheet does).
 *
 * WHY THE IDS EXIST. A `role="switch"` takes its accessible name from the AUTHOR only, so the
 * two lines of text beside it are not its name: to a screen-reader user this was 39 unnamed
 * toggles, and axe scored `aria-toggle-field-name` (serious) with exactly that node count on
 * `/[org]/~/settings/roles`, in both themes — the route's only violation.
 *
 * `aria-labelledby` points at the two lines ALREADY on screen rather than authoring a 39-entry
 * table of `aria-label` strings. The name is then the visible text by construction and cannot
 * drift from it, and a permission added to the registry is named without anyone remembering to
 * name it. Both lines, in the order they are read: "Create · project:create". The action alone
 * is ambiguous across groups — every resource has a `create`.
 */
function PermissionRow({
  permissionKey,
  action,
  checked,
  readOnly,
  onToggle,
}: {
  permissionKey: string;
  action: string;
  checked: boolean;
  readOnly?: boolean;
  onToggle: (key: string, on: boolean) => void;
}) {
  const actionId = useId();
  const keyId = useId();
  return (
    <div className={PERMISSION_ROW_CLASS}>
      <div className="min-w-0">
        <p id={actionId} className={PERMISSION_ACTION_CLASS}>
          {permissionActionLabel(action)}
        </p>
        <p id={keyId} className={PERMISSION_KEY_CLASS}>
          {permissionKey}
        </p>
      </div>
      <Switch
        aria-labelledby={`${actionId} ${keyId}`}
        checked={checked}
        disabled={readOnly}
        onCheckedChange={
          readOnly ? undefined : (on) => onToggle(permissionKey, on)
        }
      />
    </div>
  );
}
