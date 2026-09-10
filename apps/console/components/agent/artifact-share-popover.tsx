"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Building2, Check, Loader2, Share2, Shield, Users } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type ArtifactShareAccess,
  type ShareScopeType,
  getArtifactShareAccess,
  listArtifactShares,
  shareArtifact,
  unshareArtifact,
} from "@/app/server/actions/artifact-shares";
import { ConfirmDialog } from "@/components/alerts/confirm-dialog";
import { track } from "@/lib/analytics/track";
import { Button } from "@repo/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@repo/ui/popover";

/** A share target's stable key — `${scopeType}:${scopeId ?? ""}`. */
function keyOf(scopeType: ShareScopeType, scopeId: string | null): string {
  return `${scopeType}:${scopeId ?? ""}`;
}

/**
 * The Claude-Code-style "Share" control on a saved artifact: a button + popover to grant it to
 * the whole org, a specific team, or a role. Self-gating — renders nothing unless the caller's
 * org can collaborate (paid, more than one member). Only the artifact's creator sees it.
 */
export function ArtifactSharePopover({ artifactId }: { artifactId: string }) {
  const [access, setAccess] = useState<ArtifactShareAccess | null>(null);
  const [open, setOpen] = useState(false);
  const [shared, setShared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Whether the Share UI is available at all (one lookup per artifact view).
  useEffect(() => {
    let cancelled = false;
    void getArtifactShareAccess()
      .then((a) => {
        if (!cancelled) setAccess(a);
      })
      .catch(() => {
        if (!cancelled) setAccess({ canShare: false, teams: [], roles: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the current share targets whenever the popover opens.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void listArtifactShares(artifactId)
      .then((rows) =>
        setShared(new Set(rows.map((r) => keyOf(r.scopeType, r.scopeId)))),
      )
      .catch(() => setShared(new Set()))
      .finally(() => setLoading(false));
  }, [open, artifactId]);

  // The share target an UNSHARE has been requested for. Turning a target off revokes every
  // teammate's access to the artifact in one optimistic click with nothing to undo it, so it asks
  // first (#4280). Turning one ON grants access and is not destructive — it stays a bare click.
  const [pendingUnshare, setPendingUnshare] = useState<{
    scopeType: ShareScopeType;
    scopeId: string | null;
    label: string;
  } | null>(null);

  const applyToggle = useCallback(
    async (scopeType: ShareScopeType, scopeId: string | null) => {
      const k = keyOf(scopeType, scopeId);
      const isOn = shared.has(k);
      setBusy(k);
      setShared((prev) => {
        const next = new Set(prev);
        if (isOn) next.delete(k);
        else next.add(k);
        return next;
      });
      try {
        if (isOn) {
          await unshareArtifact(artifactId, scopeType, scopeId ?? undefined);
        } else {
          await shareArtifact(artifactId, scopeType, scopeId ?? undefined);
        }
        track(isOn ? "elench_artifact_unshared" : "elench_artifact_shared", {
          scope: scopeType,
        });
      } catch {
        // Revert the optimistic flip on failure.
        setShared((prev) => {
          const next = new Set(prev);
          if (isOn) next.add(k);
          else next.delete(k);
          return next;
        });
      } finally {
        setBusy(null);
      }
    },
    [artifactId, shared],
  );

  /** Grant immediately; ask before revoking. */
  const toggle = useCallback(
    (scopeType: ShareScopeType, scopeId: string | null, label: string) => {
      if (shared.has(keyOf(scopeType, scopeId))) {
        setPendingUnshare({ scopeType, scopeId, label });
        return;
      }
      void applyToggle(scopeType, scopeId);
    },
    [applyToggle, shared],
  );

  if (!access?.canShare) return null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button size="sm" variant="outline" className="gap-1.5 rounded-none">
              <Share2 className="h-3.5 w-3.5" />
              Share
            </Button>
          }
        />
        <PopoverContent align="end" className="w-72 rounded-none p-0">
          <div className="border-b border-border px-3 py-2.5">
            <div className="text-ui-md font-medium text-foreground">
              Share artifact
            </div>
            <div className="text-ui-xs text-muted-foreground">
              Choose who in your org can open this. Private to you otherwise.
            </div>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-ui-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading…
            </div>
          ) : (
            <div className="max-h-[320px] overflow-y-auto py-1">
              <ShareRow
                icon={<Building2 className="h-3.5 w-3.5" />}
                label="Everyone in org"
                sub="All members"
                checked={shared.has(keyOf("org", null))}
                busy={busy === keyOf("org", null)}
                onClick={() => toggle("org", null, "everyone in your org")}
              />
              {access.teams.length > 0 && <SectionLabel>Teams</SectionLabel>}
              {access.teams.map((t) => (
                <ShareRow
                  key={t.id}
                  icon={<Users className="h-3.5 w-3.5" />}
                  label={t.name}
                  checked={shared.has(keyOf("team", t.id))}
                  busy={busy === keyOf("team", t.id)}
                  onClick={() => toggle("team", t.id, t.name)}
                />
              ))}
              {access.roles.length > 0 && <SectionLabel>Roles</SectionLabel>}
              {access.roles.map((r) => (
                <ShareRow
                  key={r.id}
                  icon={<Shield className="h-3.5 w-3.5" />}
                  label={r.name}
                  checked={shared.has(keyOf("role", r.id))}
                  busy={busy === keyOf("role", r.id)}
                  onClick={() => toggle("role", r.id, r.name)}
                />
              ))}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* OUTSIDE the popover on purpose: opening the dialog moves focus, which closes the popover,
          and a confirmation that unmounts with its trigger cannot be answered. */}
      <ConfirmDialog
        open={pendingUnshare !== null}
        onOpenChange={(o) => {
          if (!o) setPendingUnshare(null);
        }}
        title={`Stop sharing with ${pendingUnshare?.label ?? "this target"}?`}
        description="They lose access to this artifact immediately. Anything they already copied into their own conversations stays with them."
        confirmLabel="Stop sharing"
        onConfirm={() => {
          if (pendingUnshare)
            void applyToggle(pendingUnshare.scopeType, pendingUnshare.scopeId);
          setPendingUnshare(null);
        }}
      />
    </>
  );
}

/** A tiny uppercase mono section header inside the popover. */
function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="vx-eyebrow px-3 pb-1 pt-2.5 text-ui-3xs text-muted-foreground">
      {children}
    </div>
  );
}

/** One toggleable share target with a leading icon and a right-aligned check box. */
function ShareRow({
  icon,
  label,
  sub,
  checked,
  busy,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  checked: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-muted disabled:opacity-60"
    >
      <span className="flex size-6 flex-none items-center justify-center border border-border text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-md text-foreground">
          {label}
        </span>
        {sub && (
          <span className="block text-ui-2xs text-muted-foreground">
            {sub}
          </span>
        )}
      </span>
      <span
        className={
          "flex size-4 flex-none items-center justify-center border transition-colors " +
          (checked
            ? "border-foreground bg-foreground text-background"
            : "border-border")
        }
      >
        {busy ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : checked ? (
          <Check className="h-3 w-3" />
        ) : null}
      </span>
    </button>
  );
}
