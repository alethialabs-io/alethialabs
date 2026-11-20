// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a board starts from (#6836): reading `?seed=`, and turning a starting point into design
// changes.
//
// Everything here is a pure function or a function of the document store it is handed. Nothing
// reads the URL, a query or React: `use-board-seed.ts` does that and calls in here, and the guide's
// own starts call the same `applyTemplate`, so a template chosen on the create screen and one chosen
// on the board cannot produce different designs.
//
// The store does no parsing and no offered-cloud check (`lib/canvas/store/types.ts`, `BoardSeed`).
// This module is the caller that does both, through the hand-off contract, with the offered list
// it is given — which is the server's, never the build-time default.

import {
	buildCreateInput,
	templateOption,
	type TemplateId,
} from "@/components/create-project/templates";
import { applySizingOneWriter } from "@/lib/cloud-providers/node-sizing";
import type { CloudProviderSlug } from "@/lib/cloud-providers";
import {
	CLOUD_PROVIDER_SLUGS,
	isCloudProviderSlug,
} from "@/lib/cloud-providers/provider-slug";
import { stableStringify } from "@/lib/canvas/design-revision";
import type { CanvasNode } from "@/components/design-project/canvas/graph/types";
import type { DocumentStore } from "@/lib/canvas/store/document-store";
import { PROJECT_NODE_ID } from "@/lib/canvas/store/types";
import {
	CANVAS_SEED_PARAM,
	type CanvasSeed,
	parseCanvasSeed,
	readCanvasSeed,
} from "@/lib/projects/canvas-handoff";
import type { HandoffRefusal } from "@/lib/projects/connected-account";
import type { ParamReader } from "@/lib/query/filter-url-codec";

/** What the URL says about a starting point. */
export type SeedParam =
	/** No `?seed=`. */
	| { readonly status: "none" }
	/** A seed the contract accepts: its URL form, which is its identity, and what it parsed to. */
	| { readonly status: "ready"; readonly wire: string; readonly seed: CanvasSeed }
	/** A `?seed=` the contract refuses, and why. */
	| { readonly status: "refused"; readonly reason: HandoffRefusal };

/** The one value for "the URL carries no seed". */
const NO_SEED: SeedParam = { status: "none" };

/**
 * The seed the URL carries, checked against `offered` — the clouds the SERVER says this deployment
 * offers. A refused value keeps its reason, so the board can say which of the three it was.
 */
export function readSeedParam(params: ParamReader, offered: readonly string[]): SeedParam {
	const wire = params.get(CANVAS_SEED_PARAM);
	if (wire === null) return NO_SEED;
	const seed = readCanvasSeed(params, offered);
	if (seed !== null) return { status: "ready", wire, seed };
	const parsed = parseCanvasSeed(wire, offered);
	// Unreachable while `readCanvasSeed` and `parseCanvasSeed` agree; a seed is never invented here.
	return { status: "refused", reason: parsed.ok ? "malformed" : parsed.reason };
}

/** Why a seed was refused, as one sentence a person can act on. The board stays usable. */
export function seedRefusalSentence(reason: HandoffRefusal): string {
	switch (reason) {
		case "cloud-not-offered":
			return "This link starts the design on a cloud that is not available here, so nothing was added. Pick a starting point below.";
		case "version":
			return "This link was made by another version of Alethia, so its starting point was not applied. Pick a starting point below.";
		case "malformed":
			return "This link's starting point could not be read, so nothing was added. Pick a starting point below.";
	}
}

/** The offered clouds a cluster can be provisioned on, in the order the server listed them. */
export function templateClouds(offered: readonly string[]): CloudProviderSlug[] {
	return offered.filter(isCloudProviderSlug);
}

/** The cluster settings a template sizes, as `templates.ts` writes them for a new project. */
function templateCluster(
	templateId: TemplateId,
	provider: CloudProviderSlug,
): Record<string, unknown> {
	const { cluster } = buildCreateInput({
		projectName: "",
		template: templateId,
		provider,
		cloudIdentityId: "",
		defaultEnvironment: { name: "production", stage: "production", region: "" },
	});
	return {
		cluster_version: cluster.cluster_version,
		instance_types: cluster.instance_types,
		node_min_size: cluster.node_min_size,
		node_max_size: cluster.node_max_size,
		node_desired_size: cluster.node_desired_size,
		provider_config: cluster.provider_config,
	};
}

/** The value of `key` in a config, whatever the config's kind. */
function configValue(config: object, key: string): unknown {
	return Object.entries(config).find(([name]) => name === key)?.[1];
}

/** `value` when it is a plain object, else an empty one. */
function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: {};
}

/**
 * The part of a template's cluster settings that differs from `config`. The template's provider
 * settings are merged over the cluster's own, so a setting the template does not name is kept; and
 * a template pins a machine type, so it clears a `node_size` (the one-writer rule the inspector and
 * the CLI apply).
 */
export function templateClusterPatch(
	config: object,
	templateId: TemplateId,
	provider: CloudProviderSlug,
): Record<string, unknown> {
	const preset = templateCluster(templateId, provider);
	const wanted: Record<string, unknown> = {
		...preset,
		provider_config: {
			...asRecord(configValue(config, "provider_config")),
			...asRecord(preset.provider_config),
		},
	};
	const sized = applySizingOneWriter(wanted);
	const values = sized.ok ? sized.values : wanted;
	const patch: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(values)) {
		// The canvas holds "no size" as an absent value, which is what the inspector writes.
		const next = key === "node_size" ? (value ?? undefined) : value;
		const current = configValue(config, key);
		if (stableStringify(current ?? null) !== stableStringify(next ?? null)) patch[key] = next;
	}
	return patch;
}

/** What a template would change on a design. */
export interface TemplatePlan {
	/** The cloud the cluster is sized for: the project's own when it has one. */
	provider: CloudProviderSlug;
	/** True when the project has no cloud yet, so `provider` is stamped on the project root. */
	stampsProject: boolean;
	/** The cluster to patch, or null when the design has none and one is added. */
	clusterId: string | null;
	/** The cluster settings that change (every one of the template's, for a new cluster). */
	patch: Record<string, unknown>;
	/** False when the design already has exactly what the template sets. */
	changes: boolean;
}

/**
 * What sizing the environment's cluster from a template would change. The project's own cloud wins
 * over `fallback` (the cloud a seed or the guide named): the account the project is bound to is a
 * fact, and a template for another cloud would pin machine types that account cannot run. A project
 * with no cloud yet takes `fallback`, stamped on the project root so the inspector shows that
 * cloud's choices — the missing account is the review's to report, not a reason to refuse here.
 */
export function planTemplate(
	designNodes: readonly CanvasNode[],
	templateId: TemplateId,
	fallback: CloudProviderSlug,
	projectProvider: CloudProviderSlug | null,
): TemplatePlan {
	const provider = projectProvider ?? fallback;
	const root = designNodes.find((n) => n.id === PROJECT_NODE_ID);
	const stampsProject = projectProvider === null && !!root && root.data.provider !== provider;
	const cluster = designNodes.find((n) => n.data.kind === "cluster");
	if (!cluster) {
		return {
			provider,
			stampsProject,
			clusterId: null,
			patch: templateCluster(templateId, provider),
			changes: true,
		};
	}
	const patch = templateClusterPatch(cluster.data.config, templateId, provider);
	return {
		provider,
		stampsProject,
		clusterId: cluster.id,
		patch,
		changes: stampsProject || Object.keys(patch).length > 0,
	};
}

/**
 * Size the environment's cluster from a template (see `planTemplate`). Calls the store's own
 * actions and takes no checkpoint: the caller runs it inside `transact` (or `consumeSeed`, which
 * does), so it is one undo step.
 */
export function applyTemplate(
	document: DocumentStore,
	templateId: TemplateId,
	fallback: CloudProviderSlug,
	projectProvider: CloudProviderSlug | null,
): TemplatePlan {
	const state = document.getState();
	const plan = planTemplate(state.designNodes, templateId, fallback, projectProvider);
	if (plan.stampsProject) {
		const root = state.designNodes.find((n) => n.id === PROJECT_NODE_ID);
		state.setNodeIdentity(PROJECT_NODE_ID, root?.data.cloud_identity_id ?? null, plan.provider);
	}
	if (plan.clusterId === null) {
		state.addNodeWithConfig("cluster", plan.patch, null, undefined, null);
	} else if (Object.keys(plan.patch).length > 0) {
		state.updateNodeConfig(plan.clusterId, plan.patch);
	}
	return plan;
}

/** A template that was applied to this draft, and the cloud its seed named. */
export interface AppliedTemplate {
	templateId: TemplateId;
	provider: CloudProviderSlug;
}

/**
 * The template the draft was last seeded with, from the seed keys it recorded. The keys are the
 * seeds' URL forms; one is read for its shape only, so every provisioning cloud is accepted — the
 * offered check was made when the seed was applied.
 */
export function lastSeededTemplate(appliedSeedKeys: readonly string[]): AppliedTemplate | null {
	for (const key of [...appliedSeedKeys].reverse()) {
		const parsed = parseCanvasSeed(key, CLOUD_PROVIDER_SLUGS);
		if (parsed.ok && parsed.seed.kind === "template") {
			return { templateId: parsed.seed.templateId, provider: parsed.seed.provider };
		}
	}
	return null;
}

/** What to do with a template's starter once it is applied: one sentence, and the starter's link. */
export function templateNextStep(templateId: TemplateId): {
	title: string;
	sentence: string;
	starter: { name: string; url: string } | null;
} {
	const option = templateOption(templateId);
	return { title: option.title, sentence: option.nextStep, starter: option.starter };
}
