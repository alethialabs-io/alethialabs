// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";
import { eq } from "drizzle-orm";
import { getPdp } from "@/lib/authz";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";

const mlog = log.child({ component: "realtime-pdp-memo" });

/** How many (user, org, project) answers are kept. */
const PDP_MEMO_MAX = 10_000;

/** How long one answer is trusted (ADR 0005 D3: "TTL ≤ 60 s"). */
const PDP_MEMO_TTL_MS = 60_000;

/** How long one PDP question may take; a slower answer is a deny (and is not cached). */
export const PDP_CHECK_TIMEOUT_MS = 2_000;

/** The question the memo answers: may this actor view this project? */
export type ProjectViewCheck = (actor: Actor, projectId: string) => Promise<boolean>;

interface Entry {
	allowed: boolean;
	at: number;
	userId: string;
}

/**
 * `can(actor, 'view', project)` — NOT `enforce`, which records an activity-log entry for every call
 * (lib/authz/guard.ts `authorizeQuiet` says why that matters): the bus asks this once per hint per
 * stream, and none of those asks is a user action.
 *
 * A project that no longer exists is answered "yes". A job keeps its notice's OLD.project_id after its
 * project is deleted (ON DELETE SET NULL), and that job is now a project-less row of the org, which
 * the org arm delivers unfiltered; the read decides what the reader is shown.
 */
const defaultCheck: ProjectViewCheck = async (actor, projectId) => {
	const [row] = await getServiceDb()
		.select({ id: projects.id })
		.from(projects)
		.where(eq(projects.id, projectId))
		.limit(1);
	if (!row) return true;
	return (await getPdp().can(actor, "view", { type: "project", id: projectId })).allowed;
};

/**
 * A bounded, short-lived memo of project `view` decisions for the bus's PDP filter (#6115).
 *
 * LRU by Map insertion order, capped at {@link PDP_MEMO_MAX}; each answer expires after
 * {@link PDP_MEMO_TTL_MS}, and a stream's re-authorisation evicts its user's answers outright, so a
 * changed grant is reflected within one re-auth tick at the latest. A PDP that THROWS, or answers
 * slower than {@link PDP_CHECK_TIMEOUT_MS}, is a deny and is not cached: hints follow project view,
 * and when the answer is unknown the hint waits for the next resync.
 */
export class PdpMemo {
	private readonly entries = new Map<string, Entry>();
	private readonly byUser = new Map<string, Set<string>>();
	private readonly max: number;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly check: ProjectViewCheck;
	private readonly timeoutMs: number;

	constructor(
		opts: {
			max?: number;
			ttlMs?: number;
			now?: () => number;
			check?: ProjectViewCheck;
			timeoutMs?: number;
		} = {},
	) {
		this.timeoutMs = opts.timeoutMs ?? PDP_CHECK_TIMEOUT_MS;
		this.max = opts.max ?? PDP_MEMO_MAX;
		this.ttlMs = opts.ttlMs ?? PDP_MEMO_TTL_MS;
		this.now = opts.now ?? Date.now;
		this.check = opts.check ?? defaultCheck;
	}

	/** The cached answer, or undefined when there is none (or it expired). Refreshes LRU order. */
	peek(actor: Actor, projectId: string): boolean | undefined {
		const key = keyOf(actor, projectId);
		const hit = this.entries.get(key);
		if (!hit) return undefined;
		if (this.now() - hit.at > this.ttlMs) {
			this.remove(key, hit.userId);
			return undefined;
		}
		this.entries.delete(key);
		this.entries.set(key, hit);
		return hit.allowed;
	}

	/** The answer, from the memo or from the PDP (then cached). Never throws: an error is a deny. */
	async allowed(actor: Actor, projectId: string): Promise<boolean> {
		const cached = this.peek(actor, projectId);
		if (cached !== undefined) return cached;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
		});
		let allowed: boolean;
		try {
			const answer = await Promise.race([this.check(actor, projectId), timedOut]);
			if (answer === "timeout") {
				mlog.warn("project view check timed out; withholding the hint", {
					timeoutMs: this.timeoutMs,
				});
				return false;
			}
			allowed = answer;
		} catch (err) {
			mlog.warn("project view check failed; withholding the hint", { err });
			return false;
		} finally {
			clearTimeout(timer);
		}
		this.store(keyOf(actor, projectId), actor.userId, allowed);
		return allowed;
	}

	/** Forget every answer about `userId` (a re-authorisation just ran for them). */
	evictUser(userId: string): void {
		const keys = this.byUser.get(userId);
		if (!keys) return;
		for (const key of keys) this.entries.delete(key);
		this.byUser.delete(userId);
	}

	/** How many answers are held. */
	get size(): number {
		return this.entries.size;
	}

	private store(key: string, userId: string, allowed: boolean): void {
		this.entries.delete(key);
		this.entries.set(key, { allowed, at: this.now(), userId });
		let keys = this.byUser.get(userId);
		if (!keys) {
			keys = new Set();
			this.byUser.set(userId, keys);
		}
		keys.add(key);
		while (this.entries.size > this.max) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			const entry = this.entries.get(oldest.value);
			this.remove(oldest.value, entry?.userId ?? "");
		}
	}

	private remove(key: string, userId: string): void {
		this.entries.delete(key);
		const keys = this.byUser.get(userId);
		if (!keys) return;
		keys.delete(key);
		if (keys.size === 0) this.byUser.delete(userId);
	}
}

/** The memo key: the decision depends on who asks, in which org, about which project. */
function keyOf(actor: Actor, projectId: string): string {
	return `${actor.userId}\u0000${actor.orgId}\u0000${projectId}`;
}
