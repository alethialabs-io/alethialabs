// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import type { DashboardSpec } from "@/types/jsonb.types";

export type ArtifactTab = "config" | "plan" | "cost" | "logs" | "dashboard";

/** What the agent's artifact panel is currently showing. */
export interface Artifact {
	projectId?: string;
	jobId?: string;
	/**
	 * A generative dashboard (from the `build_dashboard` tool). `null` = the pane was opened
	 * ahead of the result (e.g. the landing's "Try now") and is awaiting the spec — the panel
	 * renders a loading state until the tool result replaces it with the built spec.
	 */
	dashboard?: DashboardSpec | null;
}

interface ArtifactState {
	artifact: Artifact | null;
	tab: ArtifactTab;
	/**
	 * Open an artifact in the panel; defaults the tab to Dashboard (when a spec is
	 * present), else Config (project) or Logs (job-only).
	 */
	open: (artifact: Artifact, tab?: ArtifactTab) => void;
	setTab: (tab: ArtifactTab) => void;
	close: () => void;
}

/** Pick the default tab for an artifact from what it carries (a pending `null` dashboard
 * still defaults to the Dashboard tab so the loading state is visible). */
function defaultTab(artifact: Artifact): ArtifactTab {
	if (artifact.dashboard !== undefined) return "dashboard";
	return artifact.projectId ? "config" : "logs";
}

/**
 * Holds the agent's active artifact (a project and/or a job, or a generative
 * dashboard). Tool-result cards call `open(...)`; the artifact panel reads it and
 * renders Dashboard / Config / Plan / Cost / Logs.
 */
export const useArtifactStore = create<ArtifactState>((set) => ({
	artifact: null,
	tab: "config",
	open: (artifact, tab) => set({ artifact, tab: tab ?? defaultTab(artifact) }),
	setTab: (tab) => set({ tab }),
	close: () => set({ artifact: null }),
}));
