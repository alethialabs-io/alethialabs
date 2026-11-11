"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The deprecation notice on the add-on card (#6543). The rule for what a deprecation MEANS — when
// new installs close, and that an existing install is never touched — is `lib/addons/deprecation.ts`;
// this file only says it, in the same alert register as the update notice beside it.
//
// Two audiences, two sentences:
//
//   not installed  steered to the replacement: one button opens its card. Past the removal date the
//                  card says new installs are closed, and the Enable button is gone (the server would
//                  refuse it anyway).
//   installed      told it keeps working, told the date, and handed the migration guide. Nothing is
//                  removed and nothing is offered that would remove it.

import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import { formatDate } from "@repo/format";
import type { AddOnDeprecationView } from "@/lib/addons/deprecation";

/** Renders the deprecation notice for one add-on. `onOpenReplacement` opens the replacement's card. */
export function AddonDeprecationNotice({
  deprecation,
  name,
  installed,
  closed,
  onOpenReplacement,
}: {
  deprecation: AddOnDeprecationView;
  name: string;
  /** Whether this environment already has the add-on. */
  installed: boolean;
  /** Whether the removal date has passed, so a new install is refused. */
  closed: boolean;
  /** Absent where there is no card to open (a test, or a surface outside the canvas). */
  onOpenReplacement?: (replacementId: string) => void;
}) {
  // Pinned to UTC: the date is a UTC day boundary, and rendering it in the viewer's zone would show
  // the day before to everyone west of Greenwich.
  const date = formatDate(`${deprecation.removalDate}T00:00:00Z`, "date", "UTC");
  const title = installed
    ? `${name} is deprecated`
    : closed
      ? `${name} no longer accepts new installs`
      : `${name} is deprecated. Use ${deprecation.replacementName} instead`;
  return (
    <Alert
      variant={!installed && closed ? "destructive" : "default"}
      role="status"
      data-testid="addon-deprecation-notice"
      data-installed={installed ? "true" : "false"}
      data-closed={closed ? "true" : "false"}
    >
      <TriangleAlert aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{deprecation.reason}</p>
        {installed ? (
          <p>
            This environment keeps it: it still deploys, and you can still change its settings.
            {closed
              ? ` New installs closed on ${date}.`
              : ` From ${date} no new environment can install it.`}{" "}
            Move to {deprecation.replacementName} when you are ready.
          </p>
        ) : closed ? (
          <p>New installs closed on {date}. Install {deprecation.replacementName} instead.</p>
        ) : (
          <p>New installs close on {date}. Environments that already have it keep it.</p>
        )}
        <p>
          <a
            href={deprecation.migrationGuideUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Read the migration guide
          </a>
        </p>
        {onOpenReplacement && (
          <Button
            type="button"
            size="sm"
            variant={installed ? "outline" : "default"}
            onClick={() => onOpenReplacement(deprecation.replacementId)}
          >
            Open {deprecation.replacementName}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
