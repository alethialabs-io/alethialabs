"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useReactFlow } from "@xyflow/react";
import { Maximize, Redo2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@repo/ui/button";
import { Separator } from "@repo/ui/separator";
import { cn } from "@repo/ui/utils";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/** A square ghost icon button sized for the controls bar. `active` marks a toggled-on tool. */
function CtrlButton({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "h-8 w-8 rounded-none",
        active && "bg-muted text-foreground",
      )}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </Button>
  );
}

/**
 * Bottom-left canvas controls: zoom out / in, fit, undo / redo — the five a board needs within
 * reach. The settings popover, the layers popover, the hand tool and a second auto-arrange button
 * used to sit here too; they live in the toolbar's ⋯ menu (View submenu) now, so a first visit
 * meets five controls rather than ten. Must render inside a ReactFlowProvider.
 */
export function CanvasControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const canUndo = useCanvasStore((s) => s.past.length > 0);
  const canRedo = useCanvasStore((s) => s.future.length > 0);

  return (
    <div className="absolute bottom-3 left-3 z-10 flex items-center border border-border bg-background/90 backdrop-blur">
      <CtrlButton label="Zoom out" onClick={() => zoomOut()}>
        <ZoomOut className="h-3.5 w-3.5" />
      </CtrlButton>
      <CtrlButton label="Zoom in" onClick={() => zoomIn()}>
        <ZoomIn className="h-3.5 w-3.5" />
      </CtrlButton>
      <CtrlButton label="Fit view" onClick={() => fitView({ padding: 0.3 })}>
        <Maximize className="h-3.5 w-3.5" />
      </CtrlButton>

      <Separator orientation="vertical" className="h-5" />

      <CtrlButton label="Undo" onClick={undo} disabled={!canUndo}>
        <Undo2 className="h-3.5 w-3.5" />
      </CtrlButton>
      <CtrlButton label="Redo" onClick={redo} disabled={!canRedo}>
        <Redo2 className="h-3.5 w-3.5" />
      </CtrlButton>
    </div>
  );
}
