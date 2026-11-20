// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a connection drawn on the board MEANS, and when it may be drawn (#6835).
//
// A line on the board is not a new model. It is a service's binding: one row of that service's
// `bindings` config, the same row the inspector's Connections list writes. So the rules here are
// the binding's own — a service is the only source, the binding schema's four kinds are the only
// targets, a target is addressed by its kind and name — and they are pure functions of the nodes,
// so the drag, the drop, the keyboard menu and the tests all ask one place.
//
// Every refusal carries a sentence. A connection that cannot be made is never dropped silently:
// the board shows the sentence while the pointer is over the card and says it again on release.

import { configName } from "@/components/design-project/canvas/graph/node-config";
import { NODE_REGISTRY } from "@/components/design-project/canvas/graph/node-registry";
import type {
	CanvasNode,
	NodeConfigMap,
	NodeKind,
} from "@/components/design-project/canvas/graph/types";
import {
	cardIdentity,
	nodeAccessibleName,
} from "@/components/design-project/canvas/nodes/node-name";
import { kindFromCollectionId } from "@/lib/canvas/collections";
import { isEnumMember } from "@/lib/coerce";
import { serviceBindingSchema } from "@/lib/validations/project-form.schema";

/** One row of a service's `bindings`, exactly as the design holds it. */
export type ServiceBinding = NonNullable<NodeConfigMap["service"]["bindings"]>[number];

/** The kinds a service can bind to: the binding schema's own enum, never a second list. */
export const BINDABLE_KINDS = serviceBindingSchema.shape.target.shape.kind.options;

/** A kind a service can bind to. */
export type BindableKind = (typeof BINDABLE_KINDS)[number];

/** True when `kind` is one a service can bind to. */
export function isBindableKind(kind: NodeKind): kind is BindableKind {
	return isEnumMember(kind, BINDABLE_KINDS);
}

/** What a binding points at: the pair the deploy resolves the target by. */
export interface BindingTargetRef {
	kind: BindableKind;
	name: string;
}

/** What drawing a line from `sourceId` to a card would do. */
export type ConnectionVerdict =
	/** One binding can be added. */
	| { outcome: "bind"; sourceId: string; targetId: string; target: BindingTargetRef }
	/** The card stands for several resources (the vault): the person picks which one. */
	| { outcome: "choose"; sourceId: string; kind: BindableKind; candidateIds: string[] }
	/** No connection. `reason` says why and what to do instead. */
	| { outcome: "refused"; reason: string };

/** "a database, cache, queue or secret" — the bindable kinds in words, from the registry. */
function bindableKindsInWords(): string {
	const words = BINDABLE_KINDS.map((kind) => NODE_REGISTRY[kind].label.toLowerCase());
	if (words.length < 2) return words.join("");
	return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/**
 * A node as a person reads it on its card: "Database orders", or the kind alone when unnamed. The
 * same words the card carries as its accessible name, so a sentence about a card names it the way
 * the card names itself.
 */
export function nodeTitle(node: CanvasNode): string {
	const { eyebrow, title } = cardIdentity(node.data);
	return nodeAccessibleName(eyebrow, title);
}

/** The bindings a service node holds; empty for any other node. */
export function bindingsOf(node: CanvasNode | undefined): ServiceBinding[] {
	if (!node || node.data.kind !== "service") return [];
	return node.data.config.bindings ?? [];
}

/** True when `bindings` already holds one to `target`. */
export function isBound(bindings: ServiceBinding[], target: BindingTargetRef): boolean {
	return bindings.some((b) => b.target.kind === target.kind && b.target.name === target.name);
}

/**
 * `bindings` with one more, to `target`. The new row injects nothing yet: which connection facts
 * become environment variables is the person's choice, made in the inspector.
 */
export function withBinding(bindings: ServiceBinding[], target: BindingTargetRef): ServiceBinding[] {
	return [...bindings, { target: { kind: target.kind, name: target.name }, inject: [] }];
}

/** `bindings` without the ones to any of `targets`. */
export function withoutBindings(
	bindings: ServiceBinding[],
	targets: BindingTargetRef[],
): ServiceBinding[] {
	return bindings.filter((b) => !targets.some((t) => isBound([b], t)));
}

/** Why `source` cannot start a connection, or null when it can. */
function sourceRefusal(source: CanvasNode | undefined): string | null {
	if (!source) return "That card is no longer on the board.";
	if (source.data.kind === "chart_workload") {
		return "A chart workload's connections are set in its inspector, not drawn on the board.";
	}
	if (source.data.kind !== "service") {
		return `Connections start from a service. ${NODE_REGISTRY[source.data.kind].label} cards do not connect to other cards.`;
	}
	return null;
}

/**
 * What a connection from `sourceId` to `targetId` would do. `targetId` may be a collection card's
 * id (the vault), which stands for every member of its kind.
 */
export function evaluateConnection(
	nodes: CanvasNode[],
	sourceId: string | null | undefined,
	targetId: string | null | undefined,
): ConnectionVerdict {
	const source = nodes.find((n) => n.id === sourceId);
	const refusal = sourceRefusal(source);
	if (!source || refusal) return { outcome: "refused", reason: refusal ?? "" };
	const sourceName = configName(source.data) || "This service";
	const bindings = bindingsOf(source);

	const collection = targetId ? kindFromCollectionId(targetId) : null;
	if (collection) {
		const title = NODE_REGISTRY[collection].collection?.title ?? NODE_REGISTRY[collection].label;
		if (!isBindableKind(collection)) {
			return {
				outcome: "refused",
				reason: `A service connects to a ${bindableKindsInWords()}. ${title} cannot be a connection target.`,
			};
		}
		const candidateIds = nodes
			.filter((n) => n.data.kind === collection)
			.filter((n) => {
				const name = configName(n.data);
				return !!name && !isBound(bindings, { kind: collection, name });
			})
			.map((n) => n.id);
		if (candidateIds.length === 0) {
			return {
				outcome: "refused",
				reason: `${sourceName} is already connected to everything in ${title}.`,
			};
		}
		return { outcome: "choose", sourceId: source.id, kind: collection, candidateIds };
	}

	const target = nodes.find((n) => n.id === targetId);
	if (!target) return { outcome: "refused", reason: "That card is no longer on the board." };
	if (target.id === source.id) {
		return { outcome: "refused", reason: "A service cannot connect to itself." };
	}
	if (target.data.kind === "external") {
		return {
			outcome: "refused",
			reason:
				"This resource comes from your own infrastructure code. Connect to it from the service's Connections tab, where you choose which of its outputs to use.",
		};
	}
	const kind = target.data.kind;
	if (!isBindableKind(kind)) {
		return {
			outcome: "refused",
			reason: `A service connects to a ${bindableKindsInWords()}. ${NODE_REGISTRY[kind].label} cannot be a connection target.`,
		};
	}
	const name = configName(target.data);
	if (!name) {
		return {
			outcome: "refused",
			reason: `Name this ${NODE_REGISTRY[kind].label.toLowerCase()} first. A connection is saved by the name of what it connects to.`,
		};
	}
	if (isBound(bindings, { kind, name })) {
		return {
			outcome: "refused",
			reason: `${sourceName} is already connected to ${nodeTitle(target)}.`,
		};
	}
	return { outcome: "bind", sourceId: source.id, targetId: target.id, target: { kind, name } };
}

/**
 * The cards on the board `sourceId` could be connected to right now, in board order. Empty when
 * the source cannot start a connection at all.
 */
export function connectableTargets(nodes: CanvasNode[], sourceId: string): CanvasNode[] {
	if (sourceRefusal(nodes.find((n) => n.id === sourceId))) return [];
	return nodes.filter((n) => evaluateConnection(nodes, sourceId, n.id).outcome === "bind");
}

/** True when a card of `kind` can start a connection: the only cards that draw a source handle. */
export function canStartConnection(kind: NodeKind): boolean {
	return kind === "service";
}

/**
 * True when a card of `kind` can ever be the end of a connection: the only cards that draw a
 * target handle. Whether one PARTICULAR connection may be made is {@link evaluateConnection}'s.
 */
export function canEndConnection(kind: NodeKind): boolean {
	return isBindableKind(kind);
}

/** The bindings a drawn edge stands for: one, or every member binding behind a collapsed card. */
export function bindingsBehindEdge(
	nodes: CanvasNode[],
	sourceId: string,
	targetId: string,
): BindingTargetRef[] {
	const bindings = bindingsOf(nodes.find((n) => n.id === sourceId));
	const collection = kindFromCollectionId(targetId);
	if (collection) {
		if (!isBindableKind(collection)) return [];
		return bindings
			.filter((b) => b.target.kind === collection)
			.filter((b) =>
				nodes.some((n) => n.data.kind === collection && configName(n.data) === b.target.name),
			)
			.map((b) => ({ kind: collection, name: b.target.name }));
	}
	const target = nodes.find((n) => n.id === targetId);
	const name = target ? configName(target.data) : undefined;
	if (!target || !name || !isBindableKind(target.data.kind)) return [];
	const ref: BindingTargetRef = { kind: target.data.kind, name };
	return isBound(bindings, ref) ? [ref] : [];
}
