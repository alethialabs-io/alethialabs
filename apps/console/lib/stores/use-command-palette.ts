// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";

/** Shared open-state for the global command palette (the "Find…" search). */
interface CommandPaletteStore {
	/** Whether the palette dialog is open. */
	open: boolean;
	/** Opens or closes the palette. */
	setOpen: (open: boolean) => void;
	/** Flips the palette open/closed (the ⌘K / F shortcut). */
	toggle: () => void;
}

/**
 * One source of truth for the command palette's visibility, so the deep-nested
 * sidebar "Find…" box, keyboard shortcuts, and the dialog itself all share it.
 */
export const useCommandPalette = create<CommandPaletteStore>((set) => ({
	open: false,
	setOpen: (open) => set({ open }),
	toggle: () => set((s) => ({ open: !s.open })),
}));
