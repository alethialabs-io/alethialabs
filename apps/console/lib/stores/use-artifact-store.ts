// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";

export type ArtifactTab = "config" | "plan" | "cost" | "logs";

/** What the agent's artifact panel is currently showing. */
export interface Artifact {
	specId?: string;
	jobId?: string;
}

interface ArtifactState {
	artifact: Artifact | null;
	tab: ArtifactTab;
	/** Open an artifact in the panel; defaults the tab to Config (spec) or Logs (job-only). */
	open: (artifact: Artifact, tab?: ArtifactTab) => void;
	setTab: (tab: ArtifactTab) => void;
	close: () => void;
}

/**
 * Holds the agent page's active artifact (a spec and/or a job). Tool-result cards
 * call `open(...)`; the artifact panel reads it and loads Config/Plan/Cost/Logs.
 */
export const useArtifactStore = create<ArtifactState>((set) => ({
	artifact: null,
	tab: "config",
	open: (artifact, tab) =>
		set({ artifact, tab: tab ?? (artifact.specId ? "config" : "logs") }),
	setTab: (tab) => set({ tab }),
	close: () => set({ artifact: null }),
}));
