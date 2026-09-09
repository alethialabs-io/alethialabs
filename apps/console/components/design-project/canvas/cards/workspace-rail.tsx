"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { motion } from "motion/react";
import { useEffect } from "react";
import { AddonConfigCard } from "@/components/addons/addon-config-card";
import { useCanvasStore, type WorkspaceCard } from "@/lib/stores/use-canvas-store";
import { InspectorPanel } from "../node-inspector";
import { ActivityCard } from "./activity-card";
import { ChartScanCard } from "./chart-scan-card";
import { EnvSettingsCard } from "./env-settings-card";
import { IacScanCard } from "./iac-scan-card";

/** Rail geometry: the bordered card width + the gap between it and the board. */
export const RAIL_W = 392;
export const RAIL_GAP = 12;

/** What the rail knows about its host, for the cards whose subject is not always present. */
export interface RailContext {
	/** The project the cards act on. Absent in the create flow, which has no project yet. */
	projectId?: string;
	/** The environment the cards read. Absent in the create flow, and null until one resolves. */
	environmentId?: string | null;
}

/**
 * Whether the rail has something to draw for a card.
 *
 * It takes the same context `CardBody` does, and that is the point rather than a convenience: the
 * two answers must be one answer. An add-on card needs a project, so in the create flow — reachable
 * with `?card=addon:grafana`, which `parseCardParam` accepts — `CardBody` drew nothing while this
 * said the rail was open, leaving a 392px empty column with no header and no close button. Every
 * case a body can decline has to be declined here too.
 *
 * `activity` used to be declined here unconditionally, because the card was declared in the store's
 * union ahead of its lane. That lane has landed, so it is declined on the same terms as the rest:
 * only when the subject it reads is not there.
 */
export function isRailOpen(card: WorkspaceCard | null, ctx: RailContext = {}): boolean {
	if (card === null) return false;
	if (card.kind === "addon") return ctx.projectId !== undefined;
	// The activity card reads one environment's jobs, so it needs both halves — the same
	// disagreement as the add-on card, one card further along.
	if (card.kind === "activity") return Boolean(ctx.projectId && ctx.environmentId);
	return true;
}

/** A stable key per card so switching cards crossfades instead of morphing one body into another. */
function cardKey(card: WorkspaceCard): string {
	switch (card.kind) {
		case "inspector":
			return `inspector:${card.nodeId}`;
		case "addon":
			return `addon:${card.itemId}`;
		case "chart-scan":
			return `chart-scan:${card.chartId}`;
		default:
			return card.kind;
	}
}

/**
 * The workspace's right-hand rail: ONE docked, non-blocking card, chosen by the store's `card`.
 * Every "open on the right" on the Architecture page renders here — the node inspector, the
 * environment settings, an add-on's install config, a BYO chart or IaC scan verdict — so nothing
 * on this page opens a modal over the board any more.
 *
 * It is mounted INSIDE the canvas (not the project shell, where the old inspector dock lived): every
 * card then sits under the React Flow provider, the BYO chart/IaC providers and the add-ons query
 * that the cards need, on the project route and in the create flow alike. Unmounting the canvas —
 * leaving Architecture — closes the card, which is the behaviour the shell used to reproduce with
 * an effect of its own.
 *
 * The rail draws NO top border: it sits flush under the topbar, whose `border-b` is the top line,
 * so a `border-t` here would stack into a 2px seam. Left/right/bottom only.
 */
export function WorkspaceRail({
	projectId,
	environmentId,
	onDestroyEnvironment,
}: {
	projectId?: string;
	environmentId?: string | null;
	onDestroyEnvironment?: () => void;
}) {
	const card = useCanvasStore((s) => s.card);
	const closeCard = useCanvasStore((s) => s.closeCard);

	useEffect(() => () => closeCard(), [closeCard]);

	const open = isRailOpen(card, { projectId, environmentId });

	return (
		<motion.div
			initial={false}
			animate={{ width: open ? RAIL_W + RAIL_GAP : 0 }}
			transition={{ duration: 0.2, ease: "easeOut" }}
			className="h-full shrink-0 overflow-hidden"
			data-testid="workspace-rail"
			data-open={open ? "true" : "false"}
		>
			<div className="h-full pl-3" style={{ width: RAIL_W + RAIL_GAP }}>
				<div
					className="flex h-full flex-col overflow-hidden rounded-none border-x border-b border-border bg-background"
					style={{ width: RAIL_W }}
				>
					{open && card && (
						<motion.div
							key={cardKey(card)}
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							transition={{ duration: 0.15 }}
							className="flex h-full min-h-0 flex-col"
						>
							<CardBody
								card={card}
								projectId={projectId}
								environmentId={environmentId}
								onDestroyEnvironment={onDestroyEnvironment}
							/>
						</motion.div>
					)}
				</div>
			</div>
		</motion.div>
	);
}

/** The card component for a `WorkspaceCard`. Exhaustive: a new kind must be routed here. */
function CardBody({
	card,
	projectId,
	environmentId,
	onDestroyEnvironment,
}: {
	card: WorkspaceCard;
	projectId?: string;
	environmentId?: string | null;
	onDestroyEnvironment?: () => void;
}) {
	switch (card.kind) {
		case "inspector":
			return <InspectorPanel onDestroyEnvironment={onDestroyEnvironment} />;
		case "env-settings":
			return <EnvSettingsCard />;
		case "addon":
			// `isRailOpen` declines this card without a project, so the rail never opens for it —
			// this branch keeps the types honest rather than describing a reachable state.
			return projectId ? (
				<AddonConfigCard
					itemId={card.itemId}
					projectId={projectId}
					environmentId={environmentId ?? null}
				/>
			) : null;
		case "chart-scan":
			return <ChartScanCard chartId={card.chartId} />;
		case "iac-scan":
			return <IacScanCard />;
		case "activity":
			return projectId && environmentId ? (
				<ActivityCard projectId={projectId} environmentId={environmentId} />
			) : null;
	}
}
