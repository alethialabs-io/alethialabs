"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PanelLeftClose } from "lucide-react";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { OrgSwitcher } from "@/components/org-switcher";
import { useSidebarCollapse } from "@/lib/stores/use-sidebar-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@repo/ui/tooltip";
import { cn } from "@repo/ui/utils";
import {
  buildDrills,
  buildProjectDrills,
  buildProjectSidebarNav,
  buildSidebarNav,
  type DrillId,
  projectScope,
  routeOwnedDrill,
} from "./nav-config";
import { SidebarDrill } from "./sidebar-drill";
import { SidebarNav } from "./sidebar-nav";
import { SidebarProfile } from "./sidebar-profile";

/**
 * The Vercel-style sidebar: org switcher on top, a sliding drill-in nav in the middle, and
 * the profile bar pinned at the bottom. The active drill is derived from the pathname
 * (route-owned drills auto-open on deep links); any future click-only drill opens via local
 * state and resets on navigation. The off-screen panel is inert so focus and the pointer
 * never reach it.
 */
export function AppSidebar({
  isHosted = false,
  selfRunners = false,
}: {
  isHosted?: boolean;
  /** Org runs its own runners — surfaces the gated Runners nav item. */
  selfRunners?: boolean;
}) {
  const pathname = usePathname();
  const orgSlug = useActiveOrgSlug();

  // Inside a project drilldown the whole sidebar scopes to that project; at the org overview
  // and org-global (`~`) scope it stays org-wide. Mirrors the scope-aware Settings drill.
  const projectSlug = projectScope(pathname)?.projectSlug ?? null;
  const groups = useMemo(
    () =>
      projectSlug
        ? buildProjectSidebarNav(orgSlug, projectSlug)
        : buildSidebarNav(orgSlug, { selfRunners }),
    [orgSlug, projectSlug, selfRunners],
  );
  const drills = useMemo(
    () =>
      projectSlug
        ? buildProjectDrills(orgSlug, projectSlug)
        : buildDrills(orgSlug),
    [orgSlug, projectSlug],
  );

  const { toggle, canToggle } = useSidebarCollapse();

  const routeDrill = routeOwnedDrill(pathname);
  // A click-opened drill is scoped to the path it was opened on, so any navigation
  // transparently returns to the main view — no reset effect needed. (No nav item opens a
  // click-only drill today; the machinery stays generic for future ones.)
  const [manual, setManual] = useState<{ drill: DrillId; path: string } | null>(
    null,
  );
  const manualDrill = manual?.path === pathname ? manual.drill : null;

  const activeDrill = routeDrill ?? manualDrill;
  const activeDrillDef = activeDrill ? drills[activeDrill] : null;
  const drilled = activeDrill !== null;

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="flex h-[53px] shrink-0 items-center gap-1 border-b px-2.5">
        <div className="min-w-0 flex-1">
          <OrgSwitcher />
        </div>
        {/* Collapse to the icon rail — only inside a project (org scope stays full-width). */}
        {canToggle && (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="Collapse sidebar"
                    onClick={toggle}
                    className="hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground lg:flex"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </button>
                }
              />
              <TooltipContent side="right">Collapse sidebar</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Main view — slides left + fades while a drill is open. */}
        <div
          inert={drilled}
          className={cn(
            "absolute inset-0 transition-[transform,opacity] duration-300 ease-out motion-reduce:transition-none",
            drilled
              ? "pointer-events-none -translate-x-7 opacity-0"
              : "translate-x-0 opacity-100",
          )}
        >
          <SidebarNav
            groups={groups}
            onOpenDrill={(id) => setManual({ drill: id, path: pathname })}
          />
        </div>

        {/* Drill sub-view — slides in from the right. */}
        <div
          inert={!drilled}
          className={cn(
            "absolute inset-0 transition-transform duration-300 ease-out motion-reduce:transition-none",
            drilled ? "translate-x-0" : "pointer-events-none translate-x-full",
          )}
        >
          {activeDrillDef && (
            <SidebarDrill
              drill={activeDrillDef}
              orgSlug={orgSlug}
              onBack={() => setManual(null)}
            />
          )}
        </div>
      </div>

      <SidebarProfile isHosted={isHosted} />
    </div>
  );
}
