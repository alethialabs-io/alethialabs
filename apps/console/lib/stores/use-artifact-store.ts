// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";

export type ArtifactTab =
	| "config"
	| "plan"
	| "build"
	| "deploy"
	| "cost"
	| "logs";

/** What the agent's inspector panel is currently showing. */
export interface Artifact {
	projectId?: string;
	jobId?: string;
}

interface ArtifactState {
	/** The project/job the inspector overlays the grid with (null = grid only). */
	artifact: Artifact | null;
	tab: ArtifactTab;
	/** Whether the split pane's base layer — the per-chat widget grid — is open. */
	gridOpen: boolean;
	/** Open a project/job in the inspector; defaults the tab to Config or Logs. */
	open: (artifact: Artifact, tab?: ArtifactTab) => void;
	setTab: (tab: ArtifactTab) => void;
	/** Close the inspector (falls back to the grid when it's open). */
	close: () => void;
	openGrid: () => void;
	closeGrid: () => void;
}

/** Pick the default tab for an artifact from what it carries. */
function defaultTab(artifact: Artifact): ArtifactTab {
	return artifact.projectId ? "config" : "logs";
}

/**
 * Drives the modal's split pane, which is LAYERED: the per-chat widget grid is the
 * persistent base view (`gridOpen`), and a project/job inspector (`artifact`) overlays
 * it on demand. Tool-result frames call `open(...)`; widget auto-pin calls `openGrid`.
 */
export const useArtifactStore = create<ArtifactState>((set) => ({
	artifact: null,
	tab: "config",
	gridOpen: false,
	open: (artifact, tab) => set({ artifact, tab: tab ?? defaultTab(artifact) }),
	setTab: (tab) => set({ tab }),
	close: () => set({ artifact: null }),
	openGrid: () => set({ gridOpen: true }),
	closeGrid: () => set({ gridOpen: false }),
}));
