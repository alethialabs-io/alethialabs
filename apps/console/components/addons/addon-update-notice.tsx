"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The "the catalogue now ships X" notice on the add-on card (#6537). A catalogue bump does not move a
// pinned or a GitOps-mode install, by design, so this is the only place those installs hear of one.
// The rule for WHEN it shows is `lib/addons/update-notice.ts`; this file only says it.
//
// It OFFERS and never acts on its own: a pinned install gets a one-click "Update pin to X", which is
// the user pressing a button, and a GitOps install gets the file to change, because the repo is
// theirs and Alethia does not rewrite it. A GitOps install on GitHub can also have Alethia open a
// pull request that changes that one field (#6549), which the user reviews and merges. A pull
// request the user closed is said, and only reopened when they press "Open it again".

import { ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";
import { Button } from "@repo/ui/button";
import type { GitopsBumpResult } from "@/lib/addons/gitops-bump/service";
import type { AddOnUpdateNotice } from "@/lib/addons/update-notice";
import type { GitopsBumpRecord } from "@/types/jsonb.types";

/** The GitOps bump pull request's state for the notice (#6549). */
export interface GitopsBumpView {
	/** The pull request stored on the add-on's row, or null. */
	record: GitopsBumpRecord | null;
	/** The apps repo as `owner/repo` when it is on GitHub, which is where the pull request goes; or null. */
	repo: string | null;
	/** The outcome of the last press in this card, which wins over the stored record. */
	result: GitopsBumpResult | null;
	/** True while a request is in flight. */
	pending: boolean;
	/** Asks for the pull request; `again` only after the user closed the last one. */
	onRequest: (again: boolean) => void;
}

/**
 * The pull request to show: the last press's outcome, else the stored record. Either one counts only
 * when it is for `version`, the version a press would bump to. A pull request for another version
 * belongs to a catalog or pin that has moved on, so it is treated as none, the same rule the Deploy
 * tab's `pullFor` applies (lib/gitops/deploy-status.ts).
 */
function shownPull(
	bump: GitopsBumpView,
	version: string,
): { state: "open" | "merged" | "declined"; number: number; url: string; version: string } | null {
	const r = bump.result;
	if (r && r.status !== "refused" && r.version === version) return { state: r.status, number: r.number, url: r.url, version: r.version };
	const rec = bump.record;
	return rec && rec.version === version ? { state: rec.state, number: rec.number, url: rec.url, version: rec.version } : null;
}

/**
 * The GitOps half of the notice: the pull request, or the button that opens one. `version` is the
 * version the bump moves the file to: the install's pin, else the catalog's (what a deploy seeds).
 */
function GitopsBumpOffer({ bump, version }: { bump: GitopsBumpView; version: string }) {
	const pull = shownPull(bump, version);
	const refused = bump.result?.status === "refused" ? bump.result : null;
	return (
		<div className="space-y-2" data-testid="gitops-bump">
			{pull && (
				<p>
					{pull.state === "open" && "Pull request "}
					{pull.state === "merged" && "Pull request "}
					{pull.state === "declined" && "You closed pull request "}
					<a href={pull.url} target="_blank" rel="noreferrer" className="underline underline-offset-2">
						#{pull.number}
					</a>
					{pull.state === "open" && ` moves the file to ${pull.version}. Review and merge it in your repo.`}
					{pull.state === "merged" && ` was merged. The next deploy reads ${pull.version} from the file.`}
					{pull.state === "declined" && ` for ${pull.version} without merging it, so Alethia does not open it again unless you ask.`}
				</p>
			)}
			{refused && <p role="alert">{refused.message}</p>}
			{!pull && (
				<Button type="button" size="sm" variant="outline" disabled={bump.pending} onClick={() => bump.onRequest(false)}>
					Open a pull request to {version}
				</Button>
			)}
			{(!pull || pull.state === "declined") && bump.repo && (
				<p className="text-muted-foreground">
					It is opened in <code>{bump.repo}</code>, with your own GitHub account.
				</p>
			)}
			{pull?.state === "declined" && (
				<Button type="button" size="sm" variant="outline" disabled={bump.pending} onClick={() => bump.onRequest(true)}>
					Open it again
				</Button>
			)}
		</div>
	);
}

/** Renders the update notice for one installed add-on. `onUpdatePin` is called by the pin button. */
export function AddonUpdateNotice({
  notice,
  addonId,
  name,
  pending,
  onUpdatePin,
  bump,
}: {
  notice: AddOnUpdateNotice;
  addonId: string;
  name: string;
  /** True while a save is in flight — the button is disabled rather than queued. */
  pending: boolean;
  onUpdatePin: (version: string) => void;
  /** GitOps mode: the bump pull request, when the card can request one. */
  bump?: GitopsBumpView;
}) {
  const { security, catalogVersion } = notice;
  // The version a GitOps bump moves the file to: the stored pin, else the catalog's. The same
  // `row.version ?? def.version` the bump itself resolves (lib/addons/gitops-bump/service.ts).
  const bumpVersion = notice.installedVersion ?? catalogVersion;
  // A pin to another version is not the catalog's security release, so the notice must not let the
  // file change it names read as the one that carries that release's fix.
  const pinNotSecurity = security !== null && bumpVersion !== catalogVersion;
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
            <code>spec.source.targetRevision</code> there to <code>{bumpVersion}</code>
            {bumpVersion !== catalogVersion && ", the version this environment is pinned to"}. Each
            deploy reads the file and names an older version on the Deploy tab. On GitHub, Alethia
            can open a pull request that changes only that field, for you to review.
          </p>
        )}
        {notice.kind === "gitops" && pinNotSecurity && (
          <p data-testid="gitops-pin-not-security">
            The security release is <code>{catalogVersion}</code>. This environment is pinned to{" "}
            <code>{bumpVersion}</code>, so a change to <code>{bumpVersion}</code> is not that
            release, and Alethia cannot say it includes the fix. Clear the Chart version field below
            to move to <code>{catalogVersion}</code>.
          </p>
        )}
        {notice.kind === "gitops" && bump && <GitopsBumpOffer bump={bump} version={bumpVersion} />}
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
