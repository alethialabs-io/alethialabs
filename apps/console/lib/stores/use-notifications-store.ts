// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** Cap on remembered ids so the persisted set can't grow unbounded. */
const MAX_READ_IDS = 200;

/** De-dupes a merged id list (first-seen order preserved) and caps it. */
function dedupeCapped(ids: string[]): string[] {
	const seen = new Set<string>();
	const next: string[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		next.push(id);
		if (next.length >= MAX_READ_IDS) break;
	}
	return next;
}

/**
 * Read-state for the notifications bell. The notification list itself is derived live from
 * the jobs query (`useJobNotifications`) and the support-cases query (`useSupportNotifications`);
 * this store only remembers which job / support-case ids the user has acknowledged, persisted to
 * `localStorage` so the unread badge survives reloads and is shared across tabs (unlike the
 * ephemeral React state the bell used before).
 */
interface NotificationsStore {
	/** Job ids the user has marked read (persisted, capped to the most recent). */
	readJobIds: string[];
	/** Support-case ids the user has marked read (persisted, capped to the most recent). */
	readSupportCaseIds: string[];
	/** Marks one job id read. */
	markRead: (jobId: string) => void;
	/** Marks a batch of job ids read (e.g. "Mark all read"). */
	markAllRead: (jobIds: string[]) => void;
	/** Marks one support-case id read. */
	markSupportRead: (caseId: string) => void;
	/** Marks a batch of support-case ids read (e.g. "Mark all read"). */
	markAllSupportRead: (caseIds: string[]) => void;
}

export const useNotificationsStore = create<NotificationsStore>()(
	persist(
		(set) => ({
			readJobIds: [],
			readSupportCaseIds: [],

			markRead: (jobId) => {
				set((state) => {
					if (state.readJobIds.includes(jobId)) return state;
					return { readJobIds: [jobId, ...state.readJobIds].slice(0, MAX_READ_IDS) };
				});
			},

			markAllRead: (jobIds) => {
				set((state) => ({
					readJobIds: dedupeCapped([...jobIds, ...state.readJobIds]),
				}));
			},

			markSupportRead: (caseId) => {
				set((state) => {
					if (state.readSupportCaseIds.includes(caseId)) return state;
					return {
						readSupportCaseIds: [caseId, ...state.readSupportCaseIds].slice(
							0,
							MAX_READ_IDS,
						),
					};
				});
			},

			markAllSupportRead: (caseIds) => {
				set((state) => ({
					readSupportCaseIds: dedupeCapped([
						...caseIds,
						...state.readSupportCaseIds,
					]),
				}));
			},
		}),
		{
			name: "notifications-store",
			storage: createJSONStorage(() => localStorage),
			// Additive change: v1 payloads lack `readSupportCaseIds`, which the shallow
			// merge fills from the initial `[]` — no version bump / migrate needed (the
			// store never versioned its migrations), and existing job read-state is kept.
			version: 1,
			partialize: (state) => ({
				readJobIds: state.readJobIds,
				readSupportCaseIds: state.readSupportCaseIds,
			}),
		},
	),
);
