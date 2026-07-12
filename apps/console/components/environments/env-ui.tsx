"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared presentation for the Environments surface — the grayscale status dot (reusing the
// brand `.vx-status` device), an initials avatar, and the mappings that turn a promotion's
// real data (status, gate results, protection rules) into pipeline / gate / chip views.

import { cn } from "@repo/ui/utils";
import {
	Clock,
	DollarSign,
	Layers,
	ShieldCheck,
	UserCheck,
	type LucideIcon,
} from "lucide-react";
import type { GateResult } from "@/types/jsonb.types";

/** The brand status tiers (`@repo/brand` .vx-status--*). Meaning is carried by the dot + label. */
export type StatusTier =
	| "active"
	| "pending"
	| "idle"
	| "failed"
	| "disabled"
	| "live";

/** A status dot (+ optional label), reusing the shared `.vx-status` brand device. */
export function StatusDot({
	tier,
	label,
	size = 8,
	className,
}: {
	tier: StatusTier;
	label?: string;
	size?: number;
	className?: string;
}) {
	return (
		<span className={cn(`vx-status vx-status--${tier}`, className)}>
			<span className="vx-status__dot" style={{ width: size, height: size }} />
			{label ? <span>{label}</span> : null}
		</span>
	);
}

/** A grayscale initials avatar. */
export function Avatar({
	initials,
	size = 26,
}: {
	initials: string;
	size?: number;
}) {
	return (
		<span
			className="grid shrink-0 place-items-center rounded-full border border-border-strong bg-surface-muted font-mono text-text-secondary"
			style={{ width: size, height: size, fontSize: size * 0.38 }}
		>
			{initials}
		</span>
	);
}

// ── Promotion status ─────────────────────────────────────────────────────────

export const PROMO_STATUS: Record<string, { label: string; tier: StatusTier }> = {
	PENDING_PLAN: { label: "Planning", tier: "pending" },
	PENDING_APPROVAL: { label: "Pending approval", tier: "pending" },
	APPROVED: { label: "Approved", tier: "active" },
	DEPLOYING: { label: "Deploying", tier: "live" },
	SUCCEEDED: { label: "Succeeded", tier: "active" },
	FAILED: { label: "Failed", tier: "failed" },
	BLOCKED: { label: "Blocked", tier: "failed" },
	CANCELLED: { label: "Cancelled", tier: "disabled" },
};

export function promoStatus(status: string): { label: string; tier: StatusTier } {
	return PROMO_STATUS[status] ?? { label: status, tier: "pending" };
}

// ── Pipeline (Plan → Approval → Deploy → Live) ───────────────────────────────

const STEP_TIER: Record<string, StatusTier> = {
	done: "active",
	current: "pending",
	todo: "idle",
	failed: "failed",
	cancelled: "disabled",
};
const STEP_MAP: Record<string, string[]> = {
	PENDING_PLAN: ["current", "todo", "todo", "todo"],
	PENDING_APPROVAL: ["done", "current", "todo", "todo"],
	APPROVED: ["done", "done", "current", "todo"],
	DEPLOYING: ["done", "done", "current", "todo"],
	SUCCEEDED: ["done", "done", "done", "done"],
	FAILED: ["done", "done", "failed", "todo"],
	BLOCKED: ["done", "failed", "todo", "todo"],
	CANCELLED: ["done", "cancelled", "todo", "todo"],
};
const STEP_LABELS = ["Plan", "Approval", "Deploy", "Live"];

export interface PipelineStep {
	label: string;
	tier: StatusTier;
}

/** The four-stage pipeline for a promotion status. */
export function pipelineSteps(status: string): PipelineStep[] {
	const arr = STEP_MAP[status] ?? STEP_MAP.PENDING_APPROVAL;
	return arr.map((st, i) => ({ label: STEP_LABELS[i], tier: STEP_TIER[st] }));
}

// ── Gates ────────────────────────────────────────────────────────────────────

const GATE_META: Record<GateResult["type"], { label: string; icon: LucideIcon }> = {
	predecessor_healthy: { label: "Predecessor healthy", icon: Layers },
	verify_pass: { label: "Verify pass", icon: ShieldCheck },
	soak_timer: { label: "Soak timer", icon: Clock },
	cost_delta: { label: "Cost delta", icon: DollarSign },
	manual_approval: { label: "Manual approval", icon: UserCheck },
};
const GATE_STATUS: Record<GateResult["status"], { tier: StatusTier; word: string }> = {
	pass: { tier: "active", word: "Pass" },
	fail: { tier: "failed", word: "Fail" },
	pending: { tier: "pending", word: "Pending" },
	skipped: { tier: "disabled", word: "Skipped" },
};

export interface GateView {
	type: string;
	label: string;
	icon: LucideIcon;
	tier: StatusTier;
	word: string;
	detail: string;
}

/** Maps a stored gate result to its display view. */
export function gateView(g: GateResult): GateView {
	const meta = GATE_META[g.type] ?? { label: g.type, icon: ShieldCheck };
	const st = GATE_STATUS[g.status] ?? { tier: "pending" as StatusTier, word: g.status };
	return { type: g.type, label: meta.label, icon: meta.icon, tier: st.tier, word: st.word, detail: g.detail };
}
