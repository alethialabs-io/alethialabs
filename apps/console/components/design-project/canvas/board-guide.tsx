"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { TemplateId } from "@/components/create-project/templates";
import type { CanvasNode, NodeKind } from "@/components/design-project/canvas/graph/types";
import { PROVIDERS, type CloudProviderSlug } from "@/lib/cloud-providers";
import { useBoard, useIdentities } from "@/lib/canvas/store/canvas-store-provider";
import { effectiveProvider } from "@/lib/canvas/store/derive";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import { useDesignNodes } from "@/lib/canvas/store/use-board";
import { useOutOfBandNodes } from "@/lib/canvas/store/use-board-sources";
import { CANVAS_SEED_PARAM } from "@/lib/projects/canvas-handoff";
import { hrefWithParamPatch } from "@/lib/query/view-url-params";
import { orpc } from "@/lib/rpc/client";
import {
	BoardGuideView,
	type AppliedTemplateNote,
	type CloudChoices,
} from "./empty/board-guide-view";
import {
	applyTemplate,
	lastSeededTemplate,
	planTemplate,
	readSeedParam,
	seedRefusalSentence,
	templateClouds,
	templateNextStep,
	type AppliedTemplate,
	type SeedParam,
} from "./empty/seed";
import { SeedNotice } from "./empty/seed-notice";

/**
 * The kinds a design always carries and the board never draws as cards: the project root and the
 * environment's substrate (its cluster and network, edited as environment settings). A design made
 * of only these is a blank design — "Cluster" preselected as the starting point still draws nothing.
 */
const SUBSTRATE: ReadonlySet<NodeKind> = new Set<NodeKind>(["project", "cluster", "network"]);

/**
 * Whether the board has nothing on it to draw: no component in the design, and no card beside it
 * (a BYO chart, an installed add-on, an IaC module's resource). `others` are those cards.
 *
 * Asked of the design and the cards' own reads, not of React Flow's node lookup: the lookup fills
 * in an effect after the nodes arrive, so asking it would flash the guide for a frame on every
 * board that has content. Hidden layers do not count as empty — the components are there, the
 * viewer chose not to see them.
 */
export function boardIsEmpty(
	designNodes: readonly CanvasNode[],
	others: readonly CanvasNode[],
): boolean {
	return others.length === 0 && !designNodes.some((n) => !SUBSTRATE.has(n.data.kind));
}

/** The sentence for a proposal seed: its content has no reader on the board yet. */
export const PROPOSAL_PENDING =
	"This project's proposed design is coming with the repository scan and is not drawn here yet. The board is ready to use in the meantime.";

/** The sentence for a seed that could not be checked because the offered clouds did not load. */
export const SEED_UNCHECKED =
	"This link's starting point could not be checked, so nothing was added. Reload the page to try again, or pick a starting point below.";

/** The sentence for a bring-your-own seed on an instance that has that attach flow off. */
function byoOffSentence(attach: "chart" | "iac"): string {
	const what = attach === "chart" ? "a Helm chart" : "an IaC module";
	return `Attaching ${what} is not enabled on this instance, so nothing was opened. Pick another starting point below.`;
}

interface BoardGuideProps {
	/** The project and environment the board is drawing: which cards beside the design to read. */
	projectId: string;
	environmentId?: string;
	/** Whether bring-your-own Helm charts are enabled (server flag). */
	byoHelmEnabled?: boolean;
	/** Whether chart-workload describe is enabled (server flag). */
	byoDescribeEnabled?: boolean;
	/** True while a BYO-IaC module governs the environment: nothing can be added, so no guide. */
	governed: boolean;
	/** Open the Add picker. */
	onAdd: () => void;
	/** Open the attach flow for the user's own Helm chart; absent when the instance has it off. */
	onAttachChart?: () => void;
	/** Open the attach flow for the user's own IaC module; absent when the instance has it off. */
	onAttachIac?: () => void;
}

/**
 * How a board starts (#6836). Mounted once the board holds this environment's design, it does two
 * things:
 *
 *  - THE SEED. A `?seed=` the create screen sent is read through the hand-off contract with the
 *    clouds the SERVER offers, applied to the draft once as ONE undo step, and removed from the
 *    URL. The draft records the seed, so a reload — or the same link opened again — applies
 *    nothing twice. A seed the contract refuses, or whose content is not readable yet, becomes one
 *    sentence over a board that works.
 *  - THE GUIDE. While nothing is drawn, the middle of the board says what the board is and offers
 *    the three ways to start. It is gone the moment the board has a card, and it is never shown
 *    while an IaC module governs the environment. Laid over the board without blocking it — the
 *    pane still pans and right-clicks around it.
 *
 * The guide's own name (`data-slot="board-guide"`) sits on the OVERLAY, never on the shared empty
 * region: `@repo/ui/empty` marks its region `data-slot="empty"`, and a `data-slot` passed to it
 * replaces that mark — which is how the board once read as a hand-rolled empty region to the audit
 * (T5) while rendering the shared component.
 */
export function BoardGuide({
	projectId,
	environmentId,
	byoHelmEnabled,
	byoDescribeEnabled,
	governed,
	onAdd,
	onAttachChart,
	onAttachIac,
}: BoardGuideProps) {
	const board = useBoard();
	const identities = useIdentities();
	const router = useRouter();
	const searchParams = useSearchParams();
	const designNodes = useDesignNodes();
	const others = useOutOfBandNodes({ projectId, environmentId, byoHelmEnabled, byoDescribeEnabled });
	const appliedSeedKeys = useStore(board.document, (s) => s.appliedSeedKeys);
	// The template picked on the guide in this session. A seeded one is read from the draft instead.
	const [picked, setPicked] = useState<AppliedTemplate | null>(null);

	const empty = boardIsEmpty(designNodes, others);
	const showGuide = empty && !governed;
	const projectCloud = effectiveProvider(designNodes, PROJECT_NODE_ID, identities);
	const wire = searchParams.get(CANVAS_SEED_PARAM);

	// The clouds this deployment offers, from the server — the list a seed is checked against and a
	// project with no cloud picks from. Read only when one of the two needs it.
	const offeredQuery = useQuery({
		...orpc.connectors.board.queryOptions({ input: {} }),
		enabled: wire !== null || (showGuide && projectCloud === null),
		staleTime: 5 * 60_000,
	});
	const offered = offeredQuery.data?.offeredClouds;
	const offeredFailed = offered === undefined && offeredQuery.error != null;

	const seedParam = useMemo<SeedParam | null>(() => {
		if (wire === null) return { status: "none" };
		// Not checked yet: the offered clouds are on their way (or did not arrive).
		if (offered === undefined) return null;
		return readSeedParam({ get: (name) => (name === CANVAS_SEED_PARAM ? wire : null) }, offered);
	}, [wire, offered]);

	/** Take `?seed=` out of the URL, leaving every other param as it is. */
	const removeSeedParam = useCallback(() => {
		router.replace(
			hrefWithParamPatch(window.location.pathname, window.location.search, {
				[CANVAS_SEED_PARAM]: null,
			}),
			{ scroll: false },
		);
	}, [router]);

	// The attach openers, read when the seed is applied rather than listed as dependencies: the
	// canvas hands down a new function on every render.
	const attach = useRef({ onAttachChart, onAttachIac });
	useEffect(() => {
		attach.current = { onAttachChart, onAttachIac };
	}, [onAttachChart, onAttachIac]);
	// The seed this mount has dealt with, so a re-render before the URL has changed is not a second
	// pass. The draft's own record is what makes it once across a reload.
	const handled = useRef<string | null>(null);
	const canAttachChart = onAttachChart !== undefined;
	const canAttachIac = onAttachIac !== undefined;

	useEffect(() => {
		if (seedParam?.status !== "ready") return;
		const { wire: key, seed } = seedParam;
		// A proposal's content has no reader yet; it stays in the URL for the one that will read it.
		if (seed.kind === "proposal") return;
		// An attach flow this instance has off: nothing to open. Said in a sentence, not applied.
		if (seed.kind === "byo" && !(seed.attach === "chart" ? canAttachChart : canAttachIac)) return;
		if (handled.current === key) return;
		handled.current = key;
		const document = board.document.getState();
		// False when this draft already applied this seed: a reload, or the link opened again.
		if (document.offerSeed(key, seed)) {
			const history = document.history;
			const outcome = { changed: false };
			document.consumeSeed(() => {
				if (seed.kind !== "template") return;
				const cloud = effectiveProvider(
					board.document.getState().designNodes,
					PROJECT_NODE_ID,
					identities,
				);
				outcome.changed = applyTemplate(
					board.document,
					seed.templateId,
					seed.provider,
					cloud,
				).changes;
			});
			// A seed that changed nothing — a blank board, an attach flow, a cluster that already had
			// the template's settings — is not a step to undo.
			if (!outcome.changed) board.document.getState().replaceHistory(history);
			if (seed.kind === "byo") {
				if (seed.attach === "chart") attach.current.onAttachChart?.();
				else attach.current.onAttachIac?.();
			}
		}
		removeSeedParam();
	}, [seedParam, board, identities, canAttachChart, canAttachIac, removeSeedParam]);

	/** The sentence the board owes the viewer about the seed in the URL, or null. */
	const seedSentence = (): string | null => {
		if (wire === null) return null;
		if (seedParam === null) return offeredFailed ? SEED_UNCHECKED : null;
		if (seedParam.status === "refused") return seedRefusalSentence(seedParam.reason);
		if (seedParam.status !== "ready") return null;
		const { seed } = seedParam;
		if (seed.kind === "proposal") return PROPOSAL_PENDING;
		if (seed.kind === "byo" && !(seed.attach === "chart" ? canAttachChart : canAttachIac)) {
			return byoOffSentence(seed.attach);
		}
		return null;
	};
	const sentence = seedSentence();

	/** Size the cluster from a template, as one undo step, and show the cluster it sized. */
	const startFromTemplate = (templateId: TemplateId, provider: CloudProviderSlug) => {
		const document = board.document.getState();
		const plan = planTemplate(document.designNodes, templateId, provider, projectCloud);
		// Nothing to change is not an undo step: the cluster already has the template's settings.
		if (plan.changes) {
			document.transact("template", () => {
				applyTemplate(board.document, templateId, provider, projectCloud);
			});
		}
		setPicked({ templateId, provider: plan.provider });
		board.view.getState().openCard({ kind: "env-settings" });
	};

	const cloudChoices: CloudChoices = offered
		? { status: "ready", clouds: templateClouds(offered) }
		: offeredFailed
			? { status: "error" }
			: { status: "loading" };

	// The template the board holds right now: the one picked here, else the one the draft was
	// seeded with — and only while the cluster still has its settings, so an undo takes the line away.
	const template = picked ?? lastSeededTemplate(appliedSeedKeys);
	let applied: AppliedTemplateNote | null = null;
	if (showGuide && template) {
		const plan = planTemplate(designNodes, template.templateId, template.provider, projectCloud);
		if (!plan.changes) {
			applied = { ...templateNextStep(template.templateId), cloud: PROVIDERS[plan.provider].name };
		}
	}

	return (
		<>
			{sentence !== null && <SeedNotice sentence={sentence} onDismiss={removeSeedParam} />}
			{showGuide && (
				<div
					data-slot="board-guide"
					className="pointer-events-none absolute inset-0 flex items-center justify-center p-3"
				>
					<BoardGuideView
						projectCloud={projectCloud}
						cloudChoices={cloudChoices}
						onTemplate={startFromTemplate}
						onAdd={onAdd}
						onAttachChart={onAttachChart}
						onAttachIac={onAttachIac}
						onOpenCluster={() => board.view.getState().openCard({ kind: "env-settings" })}
						applied={applied}
					/>
				</div>
			)}
		</>
	);
}
