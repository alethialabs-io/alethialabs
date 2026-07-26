"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The auto-derive half of #1247's Surface 1. Watches the charts on the canvas and, whenever one
// references an `oci://` host no chart-repo selection covers, adds the pairing itself.
//
// Runs from the canvas rather than from `attachByoChart` so it covers charts attached before this
// existed, not just newly attached ones — and so there is ONE implementation of the matching rules
// instead of a server copy and a client copy that drift.
//
// It only ever ADDS. Removal is the user's call: a repo they configured by hand must survive a chart
// being detached, and a row that stops being referenced is harmless (the runner seeds a credential
// nothing uses). `unresolved` is what the sheet surfaces — the hosts we deliberately refuse to guess.

import { useEffect, useMemo } from "react";
import { useConnectedProviders } from "@/components/design-project/connectors-context";
import {
	deriveHelmRegistries,
	type UnresolvedChartHost,
} from "@/lib/connectors/helm-registry-derive";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";

/**
 * Reconciles chart-repo selections against the project's charts. Returns the hosts that could not be
 * resolved automatically, for the Chart Repos sheet to surface.
 */
export function useHelmRegistryReconcile(): { unresolved: UnresolvedChartHost[] } {
	const nodes = useCanvasStore((s) => s.nodes);
	const addHelmRegistries = useCanvasStore((s) => s.addHelmRegistries);
	const connected = useConnectedProviders("helm_registry");

	// Both BYO charts and marketplace add-ons can name an OCI chart repo.
	const chartRepos = useMemo(
		() =>
			nodes
				.map((n) => (n.data.kind === "chart" ? n.data.config.repoUrl : null))
				.filter((v): v is string => Boolean(v)),
		[nodes],
	);

	const existing = useMemo(
		() =>
			nodes
				.filter((n) => n.data.kind === "helm_registry")
				.map((n) => (n.data.kind === "helm_registry" ? n.data.config : null))
				.filter((v): v is NonNullable<typeof v> => v !== null),
		[nodes],
	);

	const connectedSlugs = useMemo(() => connected.map((p) => p.slug), [connected]);

	const { additions, unresolved } = useMemo(
		() => deriveHelmRegistries({ chartRepos, connectedSlugs, existing }),
		[chartRepos, connectedSlugs, existing],
	);

	useEffect(() => {
		if (additions.length === 0) return;
		addHelmRegistries(additions);
		// `additions` is recomputed from the store, so once the rows land the next pass yields none —
		// the effect settles rather than looping.
	}, [additions, addHelmRegistries]);

	return { unresolved };
}
