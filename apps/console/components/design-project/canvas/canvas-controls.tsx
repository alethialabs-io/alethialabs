"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useReactFlow, useStore } from "@xyflow/react";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@repo/ui/button";
import { DisabledReason } from "@repo/ui/disabled-reason";
import { cn } from "@repo/ui/utils";
import { NOTHING_TO_FIT, useHasDrawnNodes } from "./use-has-drawn-nodes";

/** Why the zoom level cannot be pressed at 100%: it is the way back to 100%. */
const AT_DEFAULT_ZOOM = "The board is at 100%";

/**
 * A square ghost icon button sized for the zoom controls. `disabledReason` is shown in place of the
 * label's tooltip while the button is disabled, so it says WHY — through `DisabledReason`, because
 * a disabled button's own `title` is never shown.
 */
function CtrlButton({
  label,
  onClick,
  disabled,
  disabledReason,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <DisabledReason reason={disabled ? disabledReason : null}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("h-8 w-8 rounded-none", className)}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={disabled ? undefined : label}
      >
        {children}
      </Button>
    </DisabledReason>
  );
}

/**
 * Bottom-left of the board: zoom out, the zoom level, zoom in, fit. How the board is LOOKED at,
 * and nothing else.
 *
 * Undo and redo used to sit here too. They are edits, not ways of looking, and they are tools of
 * the top-centre toolbar now (#6832) — this corner once held ten controls and, on a project with a
 * scanned repository, a second card drawn over them. The zoom level is a button: it reads the
 * level and pressing it goes back to 100%; at 100% it is off. Must render inside a ReactFlowProvider.
 */
export function CanvasControls() {
  const { zoomIn, zoomOut, zoomTo, fitView } = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  const canFit = useHasDrawnNodes();
  const percent = `${Math.round(zoom * 100)}%`;
  const atDefault = Math.round(zoom * 100) === 100;

  return (
    <div
      role="group"
      aria-label="Zoom"
      className="absolute bottom-3 left-3 z-[var(--z-raised)] flex items-center border border-border bg-card"
    >
      <CtrlButton label="Zoom out" onClick={() => void zoomOut()}>
        <ZoomOut className="h-3.5 w-3.5" />
      </CtrlButton>
      {/* The level is a readout that is also the way back to 100%. At 100% there is nowhere to go
          back to, so it is off and says so, rather than being a button that does nothing. */}
      <DisabledReason reason={atDefault ? AT_DEFAULT_ZOOM : null}>
        <Button
          type="button"
          variant="ghost"
          className="h-8 min-w-12 rounded-none px-1.5 font-mono text-ui-xs tabular-nums disabled:opacity-100"
          aria-label={atDefault ? `Zoom ${percent}` : `Zoom ${percent}. Reset to 100%`}
          title={atDefault ? undefined : "Reset zoom to 100%"}
          onClick={() => void zoomTo(1)}
        >
          {percent}
        </Button>
      </DisabledReason>
      <CtrlButton label="Zoom in" onClick={() => void zoomIn()}>
        <ZoomIn className="h-3.5 w-3.5" />
      </CtrlButton>
      <CtrlButton
        label="Fit view"
        onClick={() => void fitView({ padding: 0.3 })}
        disabled={!canFit}
        disabledReason={NOTHING_TO_FIT}
      >
        <Maximize className="h-3.5 w-3.5" />
      </CtrlButton>
    </div>
  );
}
