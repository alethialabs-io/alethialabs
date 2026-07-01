// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";

/**
 * Open-state for the single project assistant. The assistant Sheet is mounted once
 * (on the project page) and read this store; any trigger anywhere in the tree — the
 * canvas toolbar "AI" button, the command palette — opens it via `setOpen(true)`,
 * without prop-drilling across the workbench/canvas subtree.
 */
interface AssistantState {
	open: boolean;
	setOpen: (open: boolean) => void;
	toggle: () => void;
}

export const useAssistantStore = create<AssistantState>((set) => ({
	open: false,
	setOpen: (open) => set({ open }),
	toggle: () => set((s) => ({ open: !s.open })),
}));
