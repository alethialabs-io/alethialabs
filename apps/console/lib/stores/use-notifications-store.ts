// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Cap on remembered ids so the persisted set can't grow unbounded. */
const MAX_READ_IDS = 200;

/**
 * Read-state for the notifications bell. The notification list itself is derived live from
 * the jobs query (`useJobNotifications`); this store only remembers which job ids the user
 * has acknowledged, persisted to `localStorage` so the unread badge survives reloads and is
 * shared across tabs (unlike the ephemeral React state the bell used before).
 */
interface NotificationsStore {
	/** Job ids the user has marked read (persisted, capped to the most recent). */
	readJobIds: string[];
	/** Marks one job id read. */
	markRead: (jobId: string) => void;
	/** Marks a batch of job ids read (e.g. "Mark all read"). */
	markAllRead: (jobIds: string[]) => void;
}

export const useNotificationsStore = create<NotificationsStore>()(
	persist(
		(set) => ({
			readJobIds: [],

			markRead: (jobId) => {
				set((state) => {
					if (state.readJobIds.includes(jobId)) return state;
					return { readJobIds: [jobId, ...state.readJobIds].slice(0, MAX_READ_IDS) };
				});
			},

			markAllRead: (jobIds) => {
				set((state) => {
					const merged = [...jobIds, ...state.readJobIds];
					// De-dupe (preserve first-seen order) and cap.
					const seen = new Set<string>();
					const next: string[] = [];
					for (const id of merged) {
						if (seen.has(id)) continue;
						seen.add(id);
						next.push(id);
						if (next.length >= MAX_READ_IDS) break;
					}
					return { readJobIds: next };
				});
			},
		}),
		{
			name: "notifications-store",
			storage: createJSONStorage(() => localStorage),
			version: 1,
			partialize: (state) => ({ readJobIds: state.readJobIds }),
		},
	),
);
