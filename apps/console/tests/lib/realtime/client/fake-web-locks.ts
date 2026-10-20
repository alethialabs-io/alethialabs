// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A faithful in-memory Web Locks manager for the real-time client's tests (#6115). It keeps what the
// spec says and what the election relies on: exclusive locks by name, a FIFO queue, `signal`
// aborting a PENDING request (removed from the queue, the promise rejects with AbortError), an abort
// AFTER the grant doing nothing, the lock released when the callback's promise settles, and
// `query()` reporting held and pending requests by client, the way `navigator.locks.query()` does.

import type { LockManagerLike } from "@/lib/realtime/client/leader";

/** One request as `query()` reports it. */
export interface LockInfo {
	name: string;
	clientId: string;
}

interface Pending {
	name: string;
	clientId: string;
	grant: () => void;
}

/** The shared lock state of one origin; `client(id)` is one document's `navigator.locks`. */
export class FakeWebLocks {
	private readonly held = new Map<string, string>();
	private readonly queue: Pending[] = [];
	/** Models an abort that LOSES the race with the grant: the pending request stays queued and is
	 * granted later anyway, to a caller that has already stopped. */
	abortsLost = false;

	/** The lock manager one document (`clientId`) sees. */
	client(clientId: string): LockManagerLike {
		return {
			request: (name, options, callback) =>
				new Promise((resolve, reject) => {
					const signal = options.signal;
					if (signal?.aborted) {
						reject(new DOMException("aborted", "AbortError"));
						return;
					}
					const entry: Pending = {
						name,
						clientId,
						grant: () => {
							signal?.removeEventListener("abort", onAbort);
							this.held.set(name, clientId);
							let result: Promise<void>;
							try {
								result = Promise.resolve(callback());
							} catch (error) {
								result = Promise.reject(error);
							}
							result.then(
								(value) => {
									this.release(name);
									resolve(value);
								},
								(error: unknown) => {
									this.release(name);
									reject(error);
								},
							);
						},
					};
					const onAbort = () => {
						const i = this.queue.indexOf(entry);
						if (i < 0) return; // already granted: an abort after the grant does nothing
						if (this.abortsLost) return;
						this.queue.splice(i, 1);
						reject(new DOMException("aborted", "AbortError"));
					};
					signal?.addEventListener("abort", onAbort);
					this.queue.push(entry);
					this.pump(name);
				}),
		};
	}

	/** What `navigator.locks.query()` would answer. */
	query(): { held: LockInfo[]; pending: LockInfo[] } {
		return {
			held: [...this.held].map(([name, clientId]) => ({ name, clientId })),
			pending: this.queue.map(({ name, clientId }) => ({ name, clientId })),
		};
	}

	/** Every request (held or pending) one document has for `name`. */
	requestsOf(clientId: string, name?: string): number {
		const { held, pending } = this.query();
		return [...held, ...pending].filter((l) => l.clientId === clientId && (name === undefined || l.name === name))
			.length;
	}

	private release(name: string): void {
		this.held.delete(name);
		this.pump(name);
	}

	private pump(name: string): void {
		if (this.held.has(name)) return;
		const i = this.queue.findIndex((p) => p.name === name);
		if (i < 0) return;
		const [next] = this.queue.splice(i, 1);
		next!.grant();
	}
}
