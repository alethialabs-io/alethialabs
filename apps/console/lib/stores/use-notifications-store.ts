// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";

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
 * One acknowledged support case: the case, and the newest message the person had seen when they
 * acknowledged it. A later message on the same case is newer than `lastMessageAt`, so the case is
 * unread again (G-08) — an id alone would have kept every later staff reply silent forever.
 */
export interface SupportAck {
	caseId: string;
	/** ISO timestamp of the case's newest message at the time of the acknowledgement. */
	lastMessageAt: string;
}

/** Puts `incoming` first (one per case, the newest acknowledgement wins) and caps the list. */
function mergeAcks(incoming: SupportAck[], existing: SupportAck[]): SupportAck[] {
	const seen = new Set<string>();
	const next: SupportAck[] = [];
	for (const ack of [...incoming, ...existing]) {
		if (seen.has(ack.caseId)) continue;
		seen.add(ack.caseId);
		next.push(ack);
		if (next.length >= MAX_READ_IDS) break;
	}
	return next;
}

/**
 * Whether the person has already seen everything on a case that has its newest message at
 * `lastMessageAt`: they acknowledged it at that message or a later one. Compared as instants,
 * so two spellings of one time agree.
 */
export function isSupportAcked(
	acks: readonly SupportAck[],
	caseId: string,
	lastMessageAt: string,
): boolean {
	const ack = acks.find((entry) => entry.caseId === caseId);
	if (ack === undefined) return false;
	const acked = Date.parse(ack.lastMessageAt);
	const latest = Date.parse(lastMessageAt);
	return Number.isFinite(acked) && Number.isFinite(latest) && acked >= latest;
}

/**
 * Read-state for the notifications bell. The notification list itself is derived live from
 * the jobs query (`useJobNotifications`) and the support-cases query (`useSupportNotifications`);
 * this store only remembers which jobs and which support-case messages the user has acknowledged,
 * persisted to `localStorage` so the unread badge survives reloads and is shared across tabs.
 */
interface NotificationsStore {
	/** Job ids the user has marked read (persisted, capped to the most recent). */
	readJobIds: string[];
	/** Support cases the user has acknowledged, each up to a message (persisted, capped). */
	supportAcks: SupportAck[];
	/** Marks one job id read. */
	markRead: (jobId: string) => void;
	/** Marks a batch of job ids read (e.g. "Mark all read"). */
	markAllRead: (jobIds: string[]) => void;
	/** Acknowledges one support case up to its newest message. */
	markSupportRead: (ack: SupportAck) => void;
	/** Acknowledges a batch of support cases (e.g. "Mark all read"). */
	markAllSupportRead: (acks: SupportAck[]) => void;
}

/** The persisted shape before version 2: support cases were remembered by id alone. */
const persistedV1Schema = z.object({ readJobIds: z.array(z.string()).catch([]) });

export const useNotificationsStore = create<NotificationsStore>()(
	persist(
		(set) => ({
			readJobIds: [],
			supportAcks: [],

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

			markSupportRead: (ack) => {
				set((state) => ({ supportAcks: mergeAcks([ack], state.supportAcks) }));
			},

			markAllSupportRead: (acks) => {
				set((state) => ({ supportAcks: mergeAcks(acks, state.supportAcks) }));
			},
		}),
		{
			name: "notifications-store",
			storage: createJSONStorage(() => localStorage),
			// v2 replaced `readSupportCaseIds` (ids, which hid every later reply) with `supportAcks`.
			// A v1 id carries no message time, so it cannot be converted: it is dropped, and the
			// server's own read watermark decides those cases until the person opens them again.
			version: 2,
			migrate: (persisted) => {
				const parsed = persistedV1Schema.safeParse(persisted);
				return { readJobIds: parsed.success ? parsed.data.readJobIds : [], supportAcks: [] };
			},
			partialize: (state) => ({
				readJobIds: state.readJobIds,
				supportAcks: state.supportAcks,
			}),
		},
	),
);
