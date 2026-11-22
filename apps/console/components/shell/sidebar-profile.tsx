"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
  ArrowUpRight,
  BookOpen,
  Code2,
  Cookie,
  History,
  Home,
  LifeBuoy,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Settings,
} from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm/confirm-action";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { InlineThemeSwitcher } from "@/components/theme-menu";
import { authClient } from "@/lib/auth/client";
import { useViewer } from "@/components/providers/viewer-provider";
import { AUTH } from "@/lib/copy/vocabulary";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";
import { globalHref } from "@/lib/routing";
import { clearAllWizardDrafts } from "@/lib/wizard/draft";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { useUpgradeSheet } from "@/components/org/upgrade-sheet-provider";
import { displayName, userInitials } from "@/lib/user-display";
import { signOutWarning, unsavedCount } from "@/components/agent/elench/draft-status/copy";
import { useRegisteredDraftsStore } from "@/components/agent/elench/draft-status/registry";
import { Avatar, AvatarFallback, AvatarImage } from "@repo/ui/avatar";
import { Button } from "@repo/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/dropdown-menu";
import { AccountSettingsDialog } from "./account-settings-dialog";
import { FeedbackDialog } from "./feedback-dialog";
import { hardNavigate } from "./hard-navigate";
import { instanceLinks } from "./instance-links";
import { NotificationsPopover } from "./notifications-popover";
import { isHostedService } from "./shell-edition";
import { useShellEdition } from "./shell-edition-provider";
import { signOutOfConsole } from "./sign-out";
import { VersionLabel } from "./version-label";
import { useConsent } from "@repo/privacy/consent-provider";

/** What the profile bar says in place of the person's name while a sign-out is under way. */
const SIGNING_OUT = "Signing out…";

/** What the person is told when the session could not be ended. */
const SIGN_OUT_FAILED = "Couldn't sign you out. You are still signed in. Try again.";

/**
 * The pinned bottom bar of the sidebar: avatar + username, a three-dot button that opens
 * the account menu, and the notifications bell. The popover carries the account header
 * (with a gear → settings), the menu list (Feedback, an inline theme toggle, the
 * help/docs links, Sign out), an optional "Upgrade to Pro" CTA, a link to the status page, and the
 * version line (`VersionLabel`: stage, platform release name, running build).
 *
 * What differs by edition is read from the instance edition the shell was given
 * (`useShellEdition`), and from nowhere else: the in-app feedback dialog and the upgrade CTA are
 * the hosted service's, and every outbound link is `instanceLinks`' answer for this instance, so
 * a self-managed console links to its operator's pages or to none.
 *
 * Sign out asks first while Elench holds messages the server has not saved (ADR 0001 D25):
 * signing out clears them from this tab. What it then does, and in what order, is
 * `signOutOfConsole` (`./sign-out.ts`).
 */
export function SidebarProfile() {
  const edition = useShellEdition();
  const isHosted = isHostedService(edition);
  const links = instanceLinks(edition);
  const orgSlug = useActiveOrgSlug();
  const { openUpgrade } = useUpgradeSheet();
  const { openPreferences } = useConsent();
  const { viewer: user } = useViewer();
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const drafts = useRegisteredDraftsStore();
  // The count the sign-out confirm names; null while it is closed.
  const [unsavedOnSignOut, setUnsavedOnSignOut] = useState<number | null>(null);
  // A sign-out is under way: the bar says so and the menu cannot start a second one. The ref is
  // what refuses the second call; the state is what draws it.
  const [signingOut, setSigningOut] = useState(false);
  const signOutStarted = useRef(false);

  // "organizations" is the paid-plan floor; show the upgrade CTA only to free orgs on
  // the hosted control plane (self-hosters have no Stripe). Only on a KNOWN `false`: `null` is the
  // workspace store not having answered yet, and a paying org must not be offered an upgrade (#5864).
  const onPaidPlan = useEntitlement("organizations");
  const showUpgrade = isHosted && onPaidPlan === false;

  /**
   * Signs out, and answers whether it did. While it runs the bar reads "Signing out…" and a second
   * call does nothing. A sign-out that succeeds leaves the page, so the pending state is only ever
   * lifted by a failure, which is reported and leaves the person signed in.
   */
  const handleSignOut = async (): Promise<boolean> => {
    if (signOutStarted.current) return false;
    signOutStarted.current = true;
    setMenuOpen(false);
    setSigningOut(true);
    const outcome = await signOutOfConsole({
      endSession: () => authClient.signOut(),
      // Signing out is the one moment the person at the keyboard has said they are done
      // with this machine, so the sign-in form's memory of them goes too — the "Last used"
      // mark and the pre-filled address. Leaving them would show the next person which
      // provider this account uses and what its address is.
      forgetAccount: () => useAuthPrefsStore.getState().forget(),
      clearWizardDrafts: clearAllWizardDrafts,
      leave: hardNavigate,
    });
    if (outcome === "failed") {
      signOutStarted.current = false;
      setSigningOut(false);
      toast.error(SIGN_OUT_FAILED);
      return false;
    }
    return true;
  };

  /**
   * The menu's Sign out: signs out at once, unless Elench holds unsaved, held or sending messages,
   * which a sign-out loses (D25); then it asks first, naming how many.
   */
  const requestSignOut = () => {
    const count = drafts === null ? 0 : unsavedCount(drafts.view.getState());
    if (count === 0) {
      void handleSignOut();
      return;
    }
    setMenuOpen(false);
    setUnsavedOnSignOut(count);
  };

  return (
    <div className="flex h-14 shrink-0 items-center gap-1.5 border-t px-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5 py-1.5">
        <Avatar className="h-7 w-7">
          <AvatarImage src={user?.image ?? undefined} alt="" />
          <AvatarFallback className="bg-muted text-ui-2xs font-medium text-muted-foreground">
            {userInitials(user)}
          </AvatarFallback>
        </Avatar>
        {/* A live region, so a sign-out under way is announced; the name it replaces is not. */}
        <span
          aria-live="polite"
          data-state={signingOut ? "signing-out" : undefined}
          className="min-w-0 flex-1 truncate text-ui-md font-medium text-foreground"
        >
          {signingOut ? SIGNING_OUT : displayName(user)}
        </span>
      </div>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label="Account menu"
              disabled={signingOut}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          }
        />
        <DropdownMenuContent align="end" side="top" className="w-64">
          <DropdownMenuLabel className="font-normal">
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 flex-col space-y-1">
                <p className="truncate text-sm font-medium leading-none">
                  {displayName(user)}
                </p>
                <p className="truncate text-xs leading-none text-muted-foreground">
                  {user?.email ?? "Loading…"}
                </p>
              </div>
              <button
                type="button"
                aria-label="Account settings"
                onClick={() => {
                  // Close the menu first, then open the dialog (avoids a focus race).
                  setMenuOpen(false);
                  setSettingsOpen(true);
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {links.report.kind === "feedback" ? (
            <DropdownMenuItem
              onSelect={(e) => {
                // Keep the dialog open after the menu dismisses (avoids a focus race).
                e.preventDefault();
                setFeedbackOpen(true);
              }}
              className="cursor-pointer"
            >
              Feedback
              <MessageSquare className="ml-auto h-4 w-4 text-muted-foreground" />
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              render={
                <a
                  href={links.report.href}
                  target="_blank"
                  rel="noreferrer"
                  className="cursor-pointer"
                >
                  Report an issue
                  <ArrowUpRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                </a>
              }
            />
          )}

          <InlineThemeSwitcher />

          {links.home !== null && (
            <DropdownMenuItem
              render={
                <a href={links.home} className="cursor-pointer">
                  Home page
                  <Home className="ml-auto h-4 w-4 text-muted-foreground" />
                </a>
              }
            />
          )}
          <DropdownMenuItem
            render={
              <a
                href={links.releaseNotes}
                target="_blank"
                rel="noreferrer"
                className="cursor-pointer"
              >
                Changelog
                <History className="ml-auto h-4 w-4 text-muted-foreground" />
              </a>
            }
          />
          <DropdownMenuItem
            render={
              <Link href={globalHref(orgSlug, "support")} className="cursor-pointer">
                Help
                <LifeBuoy className="ml-auto h-4 w-4 text-muted-foreground" />
              </Link>
            }
          />
          <DropdownMenuItem
            onSelect={() => {
              setMenuOpen(false);
              openPreferences();
            }}
            className="cursor-pointer"
          >
            Privacy settings
            <Cookie className="ml-auto h-4 w-4 text-muted-foreground" />
          </DropdownMenuItem>
          <DropdownMenuItem
            render={
              <Link href="/docs" className="cursor-pointer">
                Docs
                <BookOpen className="ml-auto h-4 w-4 text-muted-foreground" />
              </Link>
            }
          />
          <DropdownMenuItem
            render={
              <a
                href={links.source}
                target="_blank"
                rel="noreferrer"
                className="cursor-pointer"
              >
                Source &amp; licenses
                <Code2 className="ml-auto h-4 w-4 text-muted-foreground" />
              </a>
            }
          />

          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={requestSignOut}
            disabled={signingOut}
            className="cursor-pointer text-destructive focus:text-destructive"
          >
            {AUTH.signOut}
            <LogOut className="ml-auto h-4 w-4" />
          </DropdownMenuItem>

          {showUpgrade && (
            <>
              <DropdownMenuSeparator />
              <div className="px-1 py-1">
                <Button
                  className="w-full"
                  onClick={() => {
                    setMenuOpen(false);
                    openUpgrade();
                  }}
                >
                  Upgrade to Pro
                </Button>
              </div>
            </>
          )}

          {/* A link to the status page, and no sentence about the status: this menu cannot know
              it, and it used to say "All systems normal." during an outage too. */}
          {links.status !== null && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                render={
                  <a
                    href={links.status}
                    target="_blank"
                    rel="noreferrer"
                    className="cursor-pointer"
                  >
                    Status
                    <ArrowUpRight className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </a>
                }
              />
            </>
          )}

          {/* Which release this is: the stage, the platform release name, the running build. */}
          <DropdownMenuSeparator />
          <VersionLabel />
        </DropdownMenuContent>
      </DropdownMenu>

      <NotificationsPopover />

      {isHosted && (
        <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
      )}
      <AccountSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
      {/* The unsaved-messages confirm. It runs the sign-out itself: pending while the session is
          being ended, and still open, to try again, when that failed. */}
      <ConfirmAction
        open={unsavedOnSignOut !== null}
        onOpenChange={(open) => {
          if (!open) setUnsavedOnSignOut(null);
        }}
        title={`${AUTH.signOut} with unsaved messages?`}
        description={signOutWarning(unsavedOnSignOut ?? 0)}
        confirmLabel={AUTH.signOut}
        pendingLabel={SIGNING_OUT}
        severity={{ level: "confirm" }}
        run={handleSignOut}
      />
    </div>
  );
}
