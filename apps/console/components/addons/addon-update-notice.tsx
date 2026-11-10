"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "the catalogue now ships X" notice on the add-on card (#6537). A catalogue bump does not move a
// pinned or a GitOps-mode install, by design, so this is the only place those installs hear of one.
// The rule for WHEN it shows is `lib/addons/update-notice.ts`; this file only says it.
//
// It OFFERS and never acts on its own: a pinned install gets a one-click "Update pin to X", which is
// the user pressing a button, and a GitOps install gets the file to change, because the repo is
// theirs and Alethia does not rewrite it.

import { ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import type { AddOnUpdateNotice } from "@/lib/addons/update-notice";

/** Renders the update notice for one installed add-on. `onUpdatePin` is called by the pin button. */
export function AddonUpdateNotice({
  notice,
  addonId,
  name,
  pending,
  onUpdatePin,
}: {
  notice: AddOnUpdateNotice;
  addonId: string;
  name: string;
  /** True while a save is in flight — the button is disabled rather than queued. */
  pending: boolean;
  onUpdatePin: (version: string) => void;
}) {
  const { security, catalogVersion } = notice;
  const title = security
    ? `Security update: ${name} ${catalogVersion}`
    : `The catalog now ships ${name} ${catalogVersion}`;
  return (
    <Alert
      variant={security ? "destructive" : "default"}
      role="status"
      data-testid="addon-update-notice"
      data-security={security ? "true" : "false"}
    >
      {security ? <ShieldAlert aria-hidden /> : null}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-2">
        {notice.kind === "pin-behind" ? (
          <p>
            This environment is pinned to <code>{notice.installedVersion}</code>. The pin is your
            decision, so Alethia does not move it. Update it here, or clear the Chart version field
            below to follow the catalog.
          </p>
        ) : (
          <p>
            This add-on is managed in your apps repo. <code>addons/{addonId}.yaml</code> decides the
            chart version, and Alethia never rewrites that file. To move, set{" "}
            <code>spec.source.targetRevision</code> there to <code>{catalogVersion}</code>. Each
            deploy reads the file and names an older version on the Deploy tab.
          </p>
        )}
        {security && (
          <p>
            {security.summary}{" "}
            <a
              href={security.advisoryUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Read the advisory
            </a>
          </p>
        )}
        {notice.kind === "pin-behind" && (
          <Button
            type="button"
            size="sm"
            variant={security ? "default" : "outline"}
            disabled={pending}
            onClick={() => onUpdatePin(catalogVersion)}
          >
            Update pin to {catalogVersion}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
