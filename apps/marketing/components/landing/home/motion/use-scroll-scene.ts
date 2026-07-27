// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import type { RefObject } from "react";
import { type MotionValue, useScroll, useTransform } from "motion/react";

/** One motion scroll "edge" (e.g. "start end") — derived from useScroll so it stays in sync. */
type ScrollEdge =
	NonNullable<NonNullable<Parameters<typeof useScroll>[0]>["offset"]>[number];

/** How the target's scroll span maps to progress 0→1 (motion's offset pairs). */
export interface ScrollSceneOptions {
	/** Progress reaches 0 at this alignment; defaults to the target top hitting the viewport bottom. */
	start?: ScrollEdge;
	/** Progress reaches 1 at this alignment; defaults to the target bottom hitting the viewport top. */
	end?: ScrollEdge;
}

/**
 * Track a sticky/scrubbed section: returns a `progress` MotionValue that runs
 * 0→1 as `target` scrolls through the viewport. Wraps motion's `useScroll` so
 * scroll-scene sections share one calibration. SSR-safe (motion no-ops on the
 * server); pair with a reduced-motion static fallback at the call site.
 */
export function useScrollScene(
	target: RefObject<HTMLElement | null>,
	options: ScrollSceneOptions = {},
): { progress: MotionValue<number> } {
	const start = options.start ?? "start end";
	const end = options.end ?? "end start";
	const { scrollYProgress } = useScroll({
		target,
		offset: [start, end],
	});
	return { progress: scrollYProgress };
}

/**
 * Pure helper: which of `stageCount` stages a 0→1 progress value sits in
 * (clamped to `0…stageCount-1`). Use for step-through scroll scenes where each
 * stage lights one item.
 */
export function stageFromProgress(progress: number, stageCount: number): number {
	if (stageCount <= 1) return 0;
	const clamped = progress <= 0 ? 0 : progress >= 1 ? 0.999999 : progress;
	return Math.min(stageCount - 1, Math.floor(clamped * stageCount));
}

/**
 * Derive a live stage-index MotionValue from a progress MotionValue — the
 * reactive twin of `stageFromProgress` for animating the active step.
 */
export function useStageIndex(
	progress: MotionValue<number>,
	stageCount: number,
): MotionValue<number> {
	return useTransform(progress, (p) => stageFromProgress(p, stageCount));
}
