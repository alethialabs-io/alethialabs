// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/** Scaling knobs for one pool (cloud-agnostic). */
export interface PoolConfig {
	/** Always-warm floor — the pool never drops below this (never cold). */
	warmMin: number;
	/** Hard ceiling on instances. */
	max: number;
	/** Concurrent jobs one runner handles (Phase 5); divides the backlog. */
	slotsPerRunner: number;
	/** Consecutive ticks the target must sit below current before scaling down. */
	scaleDownGraceTicks: number;
}

export interface ScaleResult {
	desired: number;
	/** Carry-forward hysteresis counter for the next tick. */
	idleTicks: number;
}

/**
 * Pure desired-count for one pool. Scale UP immediately to cover the backlog above
 * the warm floor; scale DOWN only after `scaleDownGraceTicks` consecutive ticks where
 * the target sits below current (hysteresis, so the pool never flaps). Bounded to
 * [warmMin, max].
 */
export function computeDesired(
	backlog: number,
	current: number,
	cfg: PoolConfig,
	idleTicks: number,
): ScaleResult {
	const slots = Math.max(1, cfg.slotsPerRunner);
	const target = Math.min(cfg.max, cfg.warmMin + Math.ceil(Math.max(0, backlog) / slots));

	if (target > current) {
		return { desired: target, idleTicks: 0 }; // scale up now
	}
	if (target < current) {
		const ticks = idleTicks + 1;
		if (ticks >= cfg.scaleDownGraceTicks) {
			return { desired: target, idleTicks: 0 }; // grace elapsed → scale down
		}
		return { desired: current, idleTicks: ticks }; // hold, accruing idle
	}
	return { desired: current, idleTicks: 0 }; // steady
}
