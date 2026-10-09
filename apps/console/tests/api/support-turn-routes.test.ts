// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// ADR 0003 slice 8's R tests (`docs/adr/0003-chat-turn-answered-and-billed-once.md`, §11, Q11): the
// support route for a request that names a thread, and the agent-identity route, driven end to end
// through the shared route body (`lib/agent/turn-route.ts`) with ai's mock language model, over
// an IN-MEMORY FAKE of the claim state machine with real lock and compare-and-set semantics (the same
// fake as `tests/api/agent-turn-routes.test.ts`: it classifies with the real `classifyTurn` and decides
// with the real `decideAcceptance`). A support request with no `threadId` keeps its per-request hold
// (§12), and is driven here against a recording `assertAiAllowed` to pin that it did not change.

import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { getToolName, isToolUIPart, tool, type UIMessage } from "ai";
import { PgDialect } from "drizzle-orm/pg-core";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));
/** A tool part of a UI message, static or dynamic. */
type ToolPart = Extract<UIMessage["parts"][number], { toolCallId: string }>;

/** `part` resolved with `output`, as a resolved approval card leaves it. */
function resolvedPart(part: ToolPart, output: unknown): UIMessage["parts"][number] {
	if (part.type === "dynamic-tool") {
		return { type: "dynamic-tool", toolName: part.toolName, toolCallId: part.toolCallId, state: "output-available", input: part.input, output };
	}
	return { type: part.type, toolCallId: part.toolCallId, state: "output-available", input: part.input, output };
}

// ── The fake world ────────────────────────────────────────────────────────────────────────────────

/** A thread row as the fake stores it. */
interface FThread {
	id: string;
	userId: string;
	kind: "agent" | "support";
	projectId: string | null;
	status: "active" | "deleted";
	billingOrgId: string | null;
	revision: number;
	messages: UIMessage[];
	title: string;
}

/** A claim row as the fake stores it. */
interface FClaim {
	id: string;
	threadId: string;
	userId: string;
	turnId: string;
	attemptKey: string;
	state: "running" | "answered" | "failed" | "expired";
	token: string;
	attemptNo: number;
	partial: boolean;
	holdId: string | null;
	acceptedRevision: number;
	billingOrgId: string;
	answerId: string | null;
	error: string | null;
}

/** A hold (a ledger row) as the fake stores it. */
interface FHold {
	id: string;
	orgId: string;
	/** The ledger kind the hold was reserved under. */
	kind: string;
	credits: number;
	settled: boolean;
	/** How many steps it was settled for (each step costs 10 credits in the fake). */
	steps: number;
}

/** An agent identity row as the fake stores it. */
interface FAgent {
	id: string;
	user_id: string;
	org_id: string | null;
	project_id: string | null;
	persona: string;
	mission: string;
	tool_scope: string[];
}

/** Everything the fake world holds; reset before each test. */
interface World {
	sessionUser: string | null;
	/** The org the SESSION names (what `currentActor()` would answer): never the billing org. */
	sessionOrg: string;
	memberships: Map<string, Set<string>>;
	projects: Map<string, string>;
	/** Project ids the PDP refuses `view` on. */
	hiddenProjects: Set<string>;
	hosted: boolean;
	budgetRefused: boolean;
	threads: Map<string, FThread>;
	claims: FClaim[];
	holds: Map<string, FHold>;
	events: string[];
	reserveCalls: number;
	finalizeCalls: number;
	heartbeats: number;
	budgetMs: number;
	finalizeDelayMs: number;
	mismatchLog: unknown[];
	toolActors: string[];
	throwInTools: boolean;
	throwInStream: boolean;
	/** The resolver answers an actor of ANOTHER user (a resolver bug the route must not trust). */
	foreignActor: boolean;
	/** The unlocked pin read misses a pin a racing first turn wrote (so acceptance answers pin-moved). */
	pinReadMisses: boolean;
	finalizeThrows: boolean;
	heartbeatThrows: boolean;
	aiConfigured: boolean;
	/** The agent identities, by id. */
	agents: Map<string, FAgent>;
	/** The model picks `getAiModel` was asked for. */
	modelPicks: (string | undefined)[];
	/** `holdRequest` throws: a throw inside the stream's execute AFTER the attempt finalized. */
	holdThrows: boolean;
}

const world = vi.hoisted(
	(): World => ({
		sessionUser: null,
		sessionOrg: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		memberships: new Map(),
		projects: new Map(),
		hiddenProjects: new Set(),
		hosted: true,
		budgetRefused: false,
		threads: new Map(),
		claims: [],
		holds: new Map(),
		events: [],
		reserveCalls: 0,
		finalizeCalls: 0,
		heartbeats: 0,
		budgetMs: 60_000,
		finalizeDelayMs: 5,
		mismatchLog: [],
		toolActors: [],
		throwInTools: false,
		throwInStream: false,
		foreignActor: false,
		pinReadMisses: false,
		finalizeThrows: false,
		heartbeatThrows: false,
		aiConfigured: true,
		agents: new Map(),
		modelPicks: [],
		holdThrows: false,
	}),
);

const USER = "11111111-1111-4111-8111-111111111111";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const THREAD = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const PROJECT = "2b6c0d1e-7a3c-4b5d-8f0a-1c2d3e4f5a6b";
const PROJECT_B = "3c7d1e2f-8b4d-4c6e-9a1b-2d3e4f5a6b7c";
const ORG_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const AGENT = "5d8e2f3a-9c4b-4d6e-8f1a-2b3c4d5e6f7a";
const AGENT_B = "6e9f3a4b-ad5c-4e7f-9a2b-3c4d5e6f7a8b";
const AGENT_P = "7fa04b5c-be6d-4f8a-8b3c-4d5e6f7a8b9c";
const PERSONA = "You are the cost watcher.";
const PERSONA_B = "Org C's private persona.";

/** The fake tables. */
const threads = (): Map<string, FThread> => world.threads;
const claims = (): FClaim[] => world.claims;
const holds = (): Map<string, FHold> => world.holds;

vi.mock("@/lib/auth/owner", () => ({ getOwner: vi.fn(async () => world.sessionUser) }));
vi.mock("@/lib/authz/guard", () => ({
	// What the SESSION would say. The routes must never ask it: a test asserts it is not called.
	currentActor: vi.fn(async () => ({ userId: world.sessionUser, orgId: world.sessionOrg })),
	resolveTurnActor: vi.fn(async (userId: string, orgId: string) => {
		if (world.foreignActor) return { userId: "99999999-9999-4999-8999-999999999999", orgId };
		if (orgId === userId) return { userId, orgId };
		return world.memberships.get(userId)?.has(orgId) ? { userId, orgId } : null;
	}),
}));
vi.mock("@/lib/authz", () => ({
	getPdp: () => ({
		can: vi.fn(async (_actor: unknown, _action: string, ref: { type: string; id?: string }) => ({
			allowed: !(ref.type === "project" && ref.id !== undefined && world.hiddenProjects.has(ref.id)),
		})),
	}),
}));
vi.mock("@/lib/ai/provider-options", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/ai/provider-options")>();
	return {
		...real,
		cachedSystemMessage: (system: string) => {
			if (world.throwInStream) throw new Error("boom inside execute");
			return real.cachedSystemMessage(system);
		},
	};
});
vi.mock("@/lib/ai/tools", async () => {
	const { getInjectedActor } = await import("@/lib/authz/actor-context");
	/** The test tool set of the agent route: one server read tool and the org route's client tool. */
	const tools = () => {
		if (world.throwInTools) throw new Error("buildAgentTools failed");
		return {
			list_projects: tool({
				inputSchema: z.object({}),
				execute: async () => {
					world.toolActors.push(getInjectedActor()?.orgId ?? "none");
					return { projects: [] };
				},
			}),
			propose_operation: tool({ inputSchema: z.object({ operation: z.string() }) }),
		};
	};
	return { buildAgentTools: tools };
});
vi.mock("@/lib/ai/tools/support", async () => {
	const { getInjectedActor } = await import("@/lib/authz/actor-context");
	return {
		/** The test tool set of the support route: one server read tool and its one client tool. */
		buildSupportTools: () => ({
			list_projects: tool({
				inputSchema: z.object({}),
				execute: async () => {
					world.toolActors.push(getInjectedActor()?.orgId ?? "none");
					return { projects: [] };
				},
			}),
			create_support_case: tool({ inputSchema: z.object({ subject: z.string() }) }),
		}),
	};
});
vi.mock("@/lib/http/hold-request", () => ({
	holdRequest: (_req: Request) => {
		if (world.holdThrows) throw new Error("boom after finalize");
	},
}));
vi.mock("@/lib/ai/support/prompt", () => ({ supportSystemPrompt: () => "SUPPORT PERSONA" }));
// The threadless support path's per-request hold (§12): recorded, never reached by a claimed turn.
vi.mock("@/lib/billing/ai-guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/ai-guard")>()),
	assertAiAllowed: vi.fn(async () => ({ source: "included", settle: true, holdId: "legacy-hold" })),
	releaseAiHold: vi.fn(async () => undefined),
}));
vi.mock("@/lib/billing/ai-quota", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/ai-quota")>()),
	recordAiUsage: vi.fn(async () => undefined),
	meteringFailed: vi.fn(() => () => undefined),
}));

// The two reads the shared route body makes itself (the thread's pin, the project check), against the
// fake tables. Their WHERE clauses are rendered with drizzle's own dialect, so the fake answers the
// parameters the route actually bound (thread + owner; project + org), not a guess.
vi.mock("@/lib/db", async () => {
	const schema = await import("@/lib/db/schema");
	const dialect = new PgDialect();
	/** The bound parameters of a WHERE clause. */
	const params = (cond: Parameters<PgDialect["sqlToQuery"]>[0]): unknown[] => dialect.sqlToQuery(cond).params;
	/** The agent-identity read the agent route makes through `withScope`: id, then the user or org arm. */
	const tx = {
		select: () => ({
			from: (table: unknown) => ({
				where: (cond: Parameters<PgDialect["sqlToQuery"]>[0]) => ({
					limit: async () => {
						if (table !== schema.agentIdentities) throw new Error("unexpected table");
						const [id, userId, orgId] = params(cond);
						const a = world.agents.get(String(id));
						return a && (a.user_id === userId || a.org_id === orgId) ? [a] : [];
					},
				}),
			}),
		}),
	};
	return {
		withScope: async (_scope: unknown, fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
		getServiceDb: () => ({
			select: () => ({
				from: (table: unknown) => ({
					where: async (cond: Parameters<PgDialect["sqlToQuery"]>[0]) => {
						const [a, b] = params(cond);
						if (table === schema.agentThreads) {
							const t = world.threads.get(String(a));
							if (world.pinReadMisses) return [{ billingOrgId: null }];
							return t && t.userId === b ? [{ billingOrgId: t.billingOrgId }] : [];
						}
						if (table === schema.projects) {
							return world.projects.get(String(a)) === b ? [{ id: a }] : [];
						}
						throw new Error("unexpected table");
					},
				}),
			}),
		}),
	};
});

vi.mock("@/lib/observability/log", () => {
	const l = {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn((msg: string, fields?: unknown) => {
			if (msg === "finalize-answer-mismatch") world.mismatchLog.push(fields);
		}),
		error: vi.fn(),
		child: () => l,
	};
	return { log: l };
});

// ── The fake claim state machine (ADR 0003 §5) ────────────────────────────────────────────────────

vi.mock("@/lib/agent/turn-claims", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/agent/turn-claims")>();
	const { classifyTurn, turnText } = await import("@/lib/agent/turn-key");
	const { parseClientToolOutput, isClientToolName } = await import("@/lib/ai/client-tools");
	const { randomUUID } = await import("node:crypto");
	const T = () => world.threads;
	const C = () => world.claims;
	const H = () => world.holds;

	/** Per-thread lock: one transaction at a time, like `SELECT … FOR UPDATE`. */
	const locks = new Map<string, Promise<void>>();
	/** Run `fn` holding `threadId`'s lock. */
	async function withLock<X>(threadId: string, fn: () => Promise<X>): Promise<X> {
		const prev = locks.get(threadId) ?? Promise.resolve();
		let release = () => {};
		const next = new Promise<void>((r) => {
			release = r;
		});
		locks.set(threadId, prev.then(() => next));
		await prev;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	/** True when parts hold model output (text, reasoning or a tool part). */
	const hasOutput = (parts: UIMessage["parts"]) =>
		parts.some(
			(p) => (p.type === "text" && p.text.length > 0) || (p.type === "reasoning" && p.text.length > 0) || isToolUIPart(p),
		);

	/** Merge the browser's outputs of `pending` into stored `a`; null when one is missing or invalid. */
	function merge(a: UIMessage, requestA: UIMessage, pending: readonly string[]): UIMessage | null {
		const sent = new Map<string, unknown>();
		for (const p of requestA.parts) {
			if (isToolUIPart(p) && p.state === "output-available") sent.set(p.toolCallId, p.output);
		}
		const parts: UIMessage["parts"] = [];
		for (const p of a.parts) {
			if (!isToolUIPart(p) || !pending.includes(p.toolCallId)) {
				parts.push(p);
				continue;
			}
			const name = getToolName(p);
			if (!isClientToolName(name) || !sent.has(p.toolCallId)) return null;
			const parsed = parseClientToolOutput(name, sent.get(p.toolCallId));
			if (!parsed.ok) return null;
			parts.push(resolvedPart(p, parsed.output));
		}
		return { ...a, parts };
	}

	/** Settle (steps, floored) or release a hold. */
	function meter(holdId: string | null, steps: number, floor: number) {
		if (!holdId) return;
		const h = H().get(holdId);
		if (!h) return;
		h.credits = steps === 0 && floor === 0 ? 0 : Math.max(floor, steps * 10);
		h.steps = steps;
		h.settled = true;
	}

	const reserveTurn: typeof real.reserveTurn = async (input) => {
		world.reserveCalls += 1;
		if (!real.turnIdSchema.safeParse(input.turn.turnId).success) {
			return { outcome: "invalid", reason: "the turn id is malformed" };
		}
		return withLock(input.threadId, async () => {
			const refuse = (code: Parameters<typeof real.turnRefusal>[0], stored: UIMessage[], rev: number | null, answerId?: string | null) => {
				const body = real.turnRefusal(code, input.turn.turnId, stored, rev, answerId);
				return { outcome: "refused" as const, status: real.TURN_REFUSAL_STATUS[code], body };
			};
			let thread = T().get(input.threadId);
			if (thread && thread.userId !== input.userId) return refuse("thread-not-found", [], null);
			if (!thread) {
				if (input.threadKind !== "agent") return refuse("thread-not-found", [], null);
				thread = {
					id: input.threadId,
					userId: input.userId,
					kind: "agent",
					projectId: input.projectId,
					status: "active",
					billingOrgId: null,
					revision: 1,
					messages: [],
					title: "New chat",
				};
				T().set(thread.id, thread);
			}
			if (thread.status === "deleted") return refuse("thread-deleted", [], null);
			if (thread.kind !== input.threadKind || thread.projectId !== input.projectId) {
				return refuse("thread-not-found", [], null);
			}
			if (thread.billingOrgId !== null && thread.billingOrgId !== input.orgId) {
				return { outcome: "pin-moved", pinnedOrgId: thread.billingOrgId };
			}
			const stored = thread.messages;
			const mine = C().filter((c) => c.threadId === thread.id && c.userId === input.userId);
			const cls = classifyTurn({
				turn: input.turn,
				requestMessages: input.messages,
				stored,
				revision: thread.revision,
				claims: mine
					.filter((c) => c.attemptKey.startsWith("continue:"))
					.map((c) => ({ attemptKey: c.attemptKey, state: c.state, partial: c.partial })),
			});
			if (cls.outcome === "invalid") return { outcome: "invalid", reason: cls.reason };
			if (cls.outcome === "refuse") return refuse(cls.refusal, stored, thread.revision, cls.answerId);
			const u = [...input.messages].reverse().find((m) => m.role === "user" && m.id === input.turn.turnId);
			let appendTurn: UIMessage | null = null;
			let merged: UIMessage | null = null;
			if (cls.kind === "answer" && cls.appendTurn) {
				if (!u) return { outcome: "invalid", reason: "the turn is not in the request" };
				appendTurn = {
					id: u.id,
					role: "user",
					parts: u.parts,
					...(input.turnMetadata === undefined ? {} : { metadata: input.turnMetadata }),
				};
			}
			if (cls.kind === "continue" && cls.mode === "first") {
				const a = stored.at(-1);
				const ra = input.messages.at(-1);
				if (!a || !ra) throw new Error("unreachable");
				merged = merge(a, ra, cls.pending);
				if (!merged) return { outcome: "invalid", reason: "an approval output failed its schema or size cap" };
			}
			const key = mine.find((c) => c.turnId === input.turn.turnId && c.attemptKey === cls.attemptKey) ?? null;
			const running = mine.find((c) => c.state === "running") ?? null;
			const decision = real.decideAcceptance(cls, key, running !== null && running.id !== key?.id);
			if (decision.action === "refuse") return refuse(decision.refusal, stored, thread.revision);
			if (world.budgetRefused) {
				const { AiBudgetError } = await import("@/lib/billing/ai-guard");
				return { outcome: "budget", error: new AiBudgetError("Out of AI budget", "out", null, true) };
			}
			// Everything decided: write.
			if (thread.billingOrgId === null) thread.billingOrgId = input.orgId;
			const writes = appendTurn !== null || merged !== null;
			const acceptedRevision = thread.revision + (writes ? 1 : 0);
			const token = randomUUID();
			let holdId: string | null = null;
			if (world.hosted) {
				holdId = randomUUID();
				H().set(holdId, { id: holdId, orgId: input.orgId, kind: input.aiKind, credits: 100, settled: false, steps: 0 });
			}
			let claim: FClaim;
			if (decision.action === "insert") {
				claim = {
					id: randomUUID(),
					threadId: thread.id,
					userId: input.userId,
					turnId: input.turn.turnId,
					attemptKey: cls.attemptKey,
					state: "running",
					token,
					attemptNo: 1,
					partial: false,
					holdId,
					acceptedRevision,
					billingOrgId: input.orgId,
					answerId: null,
					error: null,
				};
				C().push(claim);
			} else {
				const found = C().find((c) => c.id === decision.claim.id);
				if (!found) throw new Error("unreachable");
				Object.assign(found, {
					state: "running",
					token,
					attemptNo: found.attemptNo + 1,
					answerId: null,
					partial: false,
					error: null,
					holdId,
					acceptedRevision,
					billingOrgId: input.orgId,
				});
				claim = found;
			}
			let modelInput: UIMessage[] = stored;
			if (appendTurn) {
				thread.messages = [...stored, appendTurn];
				thread.revision += 1;
				modelInput = thread.messages;
			} else if (merged) {
				thread.messages = [...stored.slice(0, -1), merged];
				thread.revision += 1;
				modelInput = thread.messages;
			} else if (cls.kind === "regenerate") {
				modelInput = stored.slice(0, -1);
			} else if (cls.kind === "continue" && cls.mode === "resume") {
				const a = stored.at(-1);
				if (!a) throw new Error("unreachable");
				modelInput = [...stored.slice(0, -1), real.cutAfterApprovalStep(a, cls.pending)];
			}
			world.events.push(`accept:${cls.attemptKey}`);
			return {
				outcome: "accepted",
				turn: {
					claimId: claim.id,
					token,
					userId: input.userId,
					threadId: thread.id,
					threadKind: input.threadKind,
					projectId: input.projectId,
					billingOrgId: input.orgId,
					aiKind: input.aiKind,
					turnId: input.turn.turnId,
					attemptKey: cls.attemptKey,
					attemptNo: claim.attemptNo,
					kind: cls.kind,
					acceptedRevision,
					charge: holdId ? { source: "included", settle: true, holdId } : { source: "included", credits: 0 },
					modelInput,
				},
			};
		});
	};

	const heartbeatTurn: typeof real.heartbeatTurn = async (turn) => {
		world.heartbeats += 1;
		if (world.heartbeatThrows) throw new Error("db unreachable");
		const c = C().find((x) => x.id === turn.claimId);
		return c !== undefined && c.state === "running" && c.token === turn.token;
	};

	const finalizeTurn: typeof real.finalizeTurn = async (turn, outcome) => {
		world.finalizeCalls += 1;
		if (world.finalizeThrows) throw new Error("db unreachable");
		await new Promise((r) => setTimeout(r, world.finalizeDelayMs));
		return withLock(turn.threadId, async () => {
			const c = C().find((x) => x.id === turn.claimId);
			if (!c || c.token !== turn.token || c.state !== "running") {
				world.events.push("finalize:lost");
				return { outcome: "lost" };
			}
			const thread = T().get(turn.threadId);
			const deleted = !thread || thread.status === "deleted";
			const moved = !deleted && thread.revision !== turn.acceptedRevision;
			let message: UIMessage | null = null;
			let mismatch = false;
			if (outcome.answer) {
				if (turn.kind === "continue") {
					const prefix = turn.modelInput.at(-1);
					const continues =
						prefix !== undefined &&
						outcome.answer.id === prefix.id &&
						outcome.answer.parts.length >= prefix.parts.length &&
						prefix.parts.every((p, i) => outcome.answer?.parts[i]?.type === p.type);
					if (!prefix || !continues) {
						mismatch = true;
					} else {
						const added = outcome.answer.parts.slice(prefix.parts.length);
						message = hasOutput(added) ? { ...prefix, parts: [...prefix.parts, ...added] } : null;
					}
				} else if (hasOutput(outcome.answer.parts)) {
					message = outcome.answer;
				}
			}
			if (mismatch) world.mismatchLog.push({ claim_id: c.id });
			const stores = message !== null && !moved;
			if (!stores || message === null) {
				c.state = "failed";
				c.error = message !== null && moved ? "transcript-moved" : mismatch ? "answer-mismatch" : (outcome.error ?? "no-output");
				meter(c.holdId, mismatch ? outcome.steps.length : 0, 0);
				world.events.push(`finalize:${message !== null && moved ? "moved" : "failed"}`);
				return message !== null && moved ? { outcome: "moved" } : { outcome: "won", state: "failed" };
			}
			const floor = outcome.partial && c.holdId ? 100 : 0;
			c.state = "answered";
			c.answerId = message.id;
			c.partial = outcome.partial;
			meter(c.holdId, outcome.steps.length, floor);
			if (deleted) {
				const recovered: FThread = {
					id: randomUUID(),
					userId: turn.userId,
					kind: "agent",
					projectId: turn.projectId,
					status: "active",
					billingOrgId: null,
					revision: 1,
					messages:
						turn.kind === "continue" ? [...turn.modelInput.slice(0, -1), message] : [...turn.modelInput, message],
					title: `Recovered: ${turnText(turn.modelInput[0] ?? message)}`,
				};
				T().set(recovered.id, recovered);
				world.events.push("finalize:deleted");
				return { outcome: "deleted", answerId: message.id, recoveredThreadId: recovered.id };
			}
			thread.messages = turn.kind === "answer" ? [...thread.messages, message] : [...thread.messages.slice(0, -1), message];
			thread.revision += 1;
			world.events.push("finalize:answered");
			return { outcome: "won", state: "answered", answerId: message.id, revision: thread.revision };
		});
	};

	return {
		...real,
		reserveTurn,
		heartbeatTurn,
		finalizeTurn,
		get TURN_BUDGET_MS() {
			return world.budgetMs;
		},
	};
});

// ── The models ────────────────────────────────────────────────────────────────────────────────────

/** One scripted model call: its stream parts, or a factory given the call's options. */
type Script =
	| LanguageModelV3StreamPart[]
	| ((options: LanguageModelV3CallOptions) => ReadableStream<LanguageModelV3StreamPart>);

/** The scripted model calls still to come, and the prompts of the calls made. */
interface ModelScript {
	scripts: Script[];
	prompts: unknown[];
	/** The options of every call made. */
	options: LanguageModelV3CallOptions[];
	/** How many calls saw their abort signal fire. */
	aborts: number;
}

const model = vi.hoisted((): ModelScript => ({ scripts: [], prompts: [], options: [], aborts: 0 }));

vi.mock("@/lib/config/ai", async () => {
	const { MockLanguageModelV3: Mock, simulateReadableStream: sim } = await import("ai/test");
	const lm = new Mock({
		provider: "test",
		modelId: "test-model",
		doStream: async (options) => {
			model.prompts.push(options.prompt);
			model.options.push(options);
			options.abortSignal?.addEventListener("abort", () => {
				model.aborts += 1;
			});
			const next = model.scripts.shift();
			const script: Script = next ?? speakParts("ok");
			return { stream: typeof script === "function" ? script(options) : sim({ chunks: script }) };
		},
	});
	// An Anthropic model, so that `thinkingOptions` answers options and the thinking tests can tell.
	const resolved = { model: lm, key: "openai/test-model", provider: "anthropic" as const };
	return {
		isAiConfigured: () => world.aiConfigured,
		getExecutorModel: () => resolved,
		getAdvisorModel: () => resolved,
		getAiModel: (pick?: string) => {
			world.modelPicks.push(pick);
			return resolved;
		},
	};
});

const USAGE = {
	inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** A model call that answers `text` and stops. */
function speakParts(text: string): LanguageModelV3StreamPart[] {
	return [
		{ type: "stream-start", warnings: [] },
		{ type: "text-start", id: "t1" },
		{ type: "text-delta", id: "t1", delta: text },
		{ type: "text-end", id: "t1" },
		{ type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: USAGE },
	];
}

/** A model call that calls `toolName` (and, with `alsoRead`, `list_projects` in the same step). */
function callParts(toolName: string, toolCallId: string, input: unknown, alsoRead = false): LanguageModelV3StreamPart[] {
	const parts: LanguageModelV3StreamPart[] = [{ type: "stream-start", warnings: [] }];
	if (alsoRead) parts.push({ type: "tool-call", toolCallId: "read-1", toolName: "list_projects", input: "{}" });
	parts.push(
		{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
		{ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
	);
	return parts;
}

/**
 * A model call that streams `head`, then waits for `gate` before it says `tail` and finishes. An abort
 * of the call errors the stream, as a provider's fetch would.
 */
function gatedParts(head: string, gate: Promise<void>, tail = " done"): Script {
	return (options) =>
		new ReadableStream<LanguageModelV3StreamPart>({
			async start(controller) {
				options.abortSignal?.addEventListener("abort", () => {
					try {
						controller.error(new DOMException("aborted", "AbortError"));
					} catch {
						// already closed
					}
				});
				controller.enqueue({ type: "stream-start", warnings: [] });
				controller.enqueue({ type: "text-start", id: "t1" });
				controller.enqueue({ type: "text-delta", id: "t1", delta: head });
				await gate;
				if (options.abortSignal?.aborted) return;
				controller.enqueue({ type: "text-delta", id: "t1", delta: tail });
				controller.enqueue({ type: "text-end", id: "t1" });
				controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage: USAGE });
				controller.close();
			},
		});
}

/** A model call that fails before emitting anything. */
function failingParts(): Script {
	return () =>
		new ReadableStream<LanguageModelV3StreamPart>({
			start(controller) {
				controller.enqueue({ type: "stream-start", warnings: [] });
				controller.enqueue({ type: "error", error: new Error("provider down") });
				controller.close();
			},
		});
}

/**
 * Run a full garbage collection now. An abort test calls it just before the client disconnects:
 * `req.signal` follows the caller's signal only while the `Request` is reachable, and a route that let
 * it go would miss the disconnect whenever a collection happened to land first (a 20s hang in the
 * queue run, never on a quiet machine). Collecting every time turns that race into a certain failure.
 */
function collectGarbage(): void {
	setFlagsFromString("--expose-gc");
	const gc: unknown = runInNewContext("gc");
	if (typeof gc === "function") gc();
}

/**
 * Wait one macrotask, then collect. The route's last synchronous reference to the request goes when
 * the turn that returned the response unwinds; collecting before that can pass on a route that has
 * already let its request go.
 */
async function collectAfterMacrotask(): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, 0);
	});
	collectGarbage();
}

/** Read `res` to its end, raising `seen.text` once the first text delta has reached the client. */
function readNoting(res: Response, seen: { text: boolean }): Promise<Chunk[]> {
	return chunksOf(res, (c) => {
		if (c.type === "text-delta") seen.text = true;
	}).catch(() => []);
}

/** A deferred: a promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

// ── Requests ──────────────────────────────────────────────────────────────────────────────────────

/** A user message. */
function userMsg(id: string, text: string, metadata?: unknown): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text }], ...(metadata === undefined ? {} : { metadata }) };
}

/** `a` with the browser's output of `toolCallId`. */
function withOutput(a: UIMessage, toolCallId: string, output: unknown): UIMessage {
	return {
		...a,
		parts: a.parts.map((p) =>
			isToolUIPart(p) && p.toolCallId === toolCallId
				? resolvedPart(p, output)
				: p,
		),
	};
}

/** The turn fields of a request. */
interface TurnFields {
	trigger?: "submit-message" | "regenerate-message";
	turnId: string;
	baseRevision: number;
	answerId?: string;
	toolCallIds?: string[];
}

/** A request body. */
function body(messages: UIMessage[], turn: TurnFields | null, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		messages,
		threadId: THREAD,
		orgId: ORG_A,
		...(turn ? { turn: { trigger: "submit-message", ...turn } } : {}),
		...extra,
	});
}

/** POST the support route. */
async function postSupport(raw: string, signal?: AbortSignal): Promise<Response> {
	const { POST } = await import("@/app/api/support/ask/route");
	return POST(new Request("https://console.local/api/support/ask", { method: "POST", body: raw, signal }));
}

/** POST the agent-identity route for `agentId`. */
async function postAgent(raw: string, agentId = AGENT, signal?: AbortSignal): Promise<Response> {
	const { POST } = await import("@/app/api/agent/[agentId]/route");
	return POST(new Request(`https://console.local/api/agent/${agentId}`, { method: "POST", body: raw, signal }), {
		params: Promise.resolve({ agentId }),
	});
}

const chunkSchema = z.looseObject({ type: z.string() });
/** One parsed SSE chunk. */
type Chunk = z.infer<typeof chunkSchema>;

/** Read a streamed response to its end: its chunks in order. */
async function chunksOf(res: Response, onChunk?: (c: Chunk) => void): Promise<Chunk[]> {
	const out: Chunk[] = [];
	if (!res.body) return out;
	const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += value;
		let i = buf.indexOf("\n\n");
		while (i >= 0) {
			const line = buf.slice(0, i).trim();
			buf = buf.slice(i + 2);
			i = buf.indexOf("\n\n");
			if (!line.startsWith("data: ")) continue;
			const data = line.slice(6);
			if (data === "[DONE]") continue;
			const chunk = chunkSchema.parse(JSON.parse(data));
			onChunk?.(chunk);
			out.push(chunk);
		}
	}
	return out;
}

const refusalSchema = z.object({
	refusal: z.string(),
	turnId: z.string().nullable(),
	committed: z.boolean(),
	textCommitted: z.boolean(),
	answered: z.boolean(),
	revision: z.number().nullable(),
	answerId: z.string().nullable(),
});

/** A refusal response's body. */
async function refusalOf(res: Response) {
	return refusalSchema.parse(await res.json());
}

/** A stored thread, seeded. */
function seedThread(messages: UIMessage[], over: Partial<FThread> = {}): FThread {
	const t: FThread = {
		id: THREAD,
		userId: USER,
		kind: "agent",
		projectId: null,
		status: "active",
		billingOrgId: null,
		revision: 1,
		messages,
		title: "t",
		...over,
	};
	threads().set(t.id, t);
	return t;
}

/** The text of every model prompt message, flattened, for "what did the model see" assertions. */
function promptText(i: number): string {
	return JSON.stringify(model.prompts[i]);
}

/** The holds, as a list. */
const holdList = () => [...holds().values()];

beforeEach(() => {
	vi.clearAllMocks();
	world.sessionUser = USER;
	world.memberships = new Map([[USER, new Set([ORG_A, ORG_B])]]);
	world.projects = new Map([
		[PROJECT, ORG_A],
		[PROJECT_B, ORG_B],
	]);
	world.hiddenProjects = new Set();
	world.hosted = true;
	world.budgetRefused = false;
	world.threads = new Map();
	world.claims = [];
	world.holds = new Map();
	world.events = [];
	world.reserveCalls = 0;
	world.finalizeCalls = 0;
	world.heartbeats = 0;
	world.budgetMs = 60_000;
	world.finalizeDelayMs = 5;
	world.mismatchLog = [];
	world.toolActors = [];
	world.throwInTools = false;
	world.throwInStream = false;
	world.foreignActor = false;
	world.pinReadMisses = false;
	world.finalizeThrows = false;
	world.heartbeatThrows = false;
	world.aiConfigured = true;
	world.agents = new Map([
		[AGENT, { id: AGENT, user_id: USER, org_id: ORG_A, project_id: null, persona: PERSONA, mission: "watch the costs", tool_scope: ["list_projects"] }],
		[AGENT_B, { id: AGENT_B, user_id: OTHER_USER, org_id: ORG_C, project_id: null, persona: PERSONA_B, mission: "secret", tool_scope: [] }],
		[AGENT_P, { id: AGENT_P, user_id: USER, org_id: ORG_A, project_id: PROJECT, persona: PERSONA, mission: "run the project", tool_scope: [] }],
	]);
	world.modelPicks = [];
	world.holdThrows = false;
	model.scripts = [];
	model.prompts = [];
	model.options = [];
	model.aborts = 0;
});

afterEach(() => {
	vi.useRealTimers();
});

/** A support thread, seeded (`kind = support`, no project). */
function seedSupportThread(messages: UIMessage[], over: Partial<FThread> = {}): FThread {
	return seedThread(messages, { kind: "support", ...over });
}

/** An answer that proposes `create_support_case` as `toolCallId`. */
function caseProposal(id: string, toolCallId: string): UIMessage {
	return {
		id,
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{ type: "tool-create_support_case", toolCallId, state: "input-available", input: { subject: "Provision fails" } },
		],
	};
}

const SUBMITTED = { status: "submitted", caseId: "8b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e", caseNumber: 42 };

/** The tool names the model was offered on call `i`. */
function offeredTools(i: number): string[] {
	const options = model.options[i];
	return (options?.tools ?? []).map((t) => t.name).sort();
}

/** How many model calls aborted mid-stream (their abort signal fired). */
const aborts = () => model.aborts;

describe("the support route, for a request that names a thread (slice 8)", () => {
	it("accepts through reserveTurn as a support thread with a support hold, settles one hold, finalizes before finish, and never reads the session", async () => {
		seedSupportThread([]);
		model.scripts.push(speakParts("Here is how to connect AWS."));
		const res = await postSupport(body([userMsg("u1", "how do I connect aws?")], { turnId: "u1", baseRevision: 1 }));
		expect(res.status).toBe(200);
		const chunks = await chunksOf(res);
		expect(chunks[0]?.type).toBe("data-turn-accepted");
		const types = chunks.map((c) => c.type);
		expect(types.indexOf("data-turn-finished")).toBeGreaterThan(-1);
		expect(types.indexOf("data-turn-finished")).toBeLessThan(types.indexOf("finish"));
		expect(world.events).toEqual(["accept:answer", "finalize:answered"]);
		const t = threads().get(THREAD);
		expect(t?.kind).toBe("support");
		expect(t?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(holdList()).toEqual([expect.objectContaining({ orgId: ORG_A, kind: "support", settled: true, steps: 1 })]);
		expect(promptText(0)).toContain("SUPPORT PERSONA");
		const { currentActor } = await import("@/lib/authz/guard");
		expect(currentActor).not.toHaveBeenCalled();
		const { assertAiAllowed } = await import("@/lib/billing/ai-guard");
		expect(assertAiAllowed).not.toHaveBeenCalled();
	});

	it("a duplicated threaded support turn: one model call, one hold, the duplicate answers turn-in-progress", async () => {
		seedSupportThread([]);
		const gate = deferred();
		model.scripts.push(gatedParts("Checking", gate.promise));
		const raw = body([userMsg("u1", "my cluster failed")], { turnId: "u1", baseRevision: 1 });
		const first = await postSupport(raw);
		const reading = chunksOf(first);
		await vi.waitFor(() => expect(model.prompts).toHaveLength(1));
		const second = await postSupport(raw);
		expect(second.status).toBe(409);
		expect(await refusalOf(second)).toMatchObject({ refusal: "turn-in-progress", committed: true });
		gate.resolve();
		await reading;
		expect(model.prompts).toHaveLength(1);
		expect(holdList()).toHaveLength(1);
		expect(holdList()[0]).toMatchObject({ settled: true, kind: "support" });
		expect(claims()).toHaveLength(1);
	});

	it("a missing support thread is 404 thread-not-found: never recreated, no hold", async () => {
		const res = await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }));
		expect(res.status).toBe(404);
		expect(await refusalOf(res)).toMatchObject({ refusal: "thread-not-found" });
		expect(threads().size).toBe(0);
		expect(holdList()).toHaveLength(0);
		expect(model.prompts).toHaveLength(0);
	});

	it("an agent thread named on the support route is thread-not-found", async () => {
		seedThread([]);
		const res = await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }));
		expect(res.status).toBe(404);
		expect(await refusalOf(res)).toMatchObject({ refusal: "thread-not-found" });
		expect(holdList()).toHaveLength(0);
	});

	it("an approved support-case card: the continuation is accepted after the answered turn, the output is stored, and the model sees it", async () => {
		const a1 = caseProposal("a1", "p1");
		seedSupportThread([userMsg("u1", "open a case"), a1], { billingOrgId: ORG_A, revision: 3 });
		claims().push({
			id: "c-answer", threadId: THREAD, userId: USER, turnId: "u1", attemptKey: "answer", state: "answered",
			token: "t0", attemptNo: 1, partial: false, holdId: null, acceptedRevision: 2, billingOrgId: ORG_A, answerId: "a1", error: null,
		});
		model.scripts.push(speakParts("Case #42 is open."));
		const raw = body([userMsg("u1", "open a case"), withOutput(a1, "p1", SUBMITTED)], {
			turnId: "u1",
			baseRevision: 3,
			answerId: "a1",
			toolCallIds: ["p1"],
		});
		const res = await postSupport(raw);
		expect(res.status).toBe(200);
		await chunksOf(res);
		expect(claims().find((c) => c.attemptKey === "continue:a1:p1")?.state).toBe("answered");
		const stored = threads().get(THREAD)?.messages;
		expect(stored).toHaveLength(2);
		expect(stored?.[1]?.id).toBe("a1");
		expect(JSON.stringify(stored?.[1])).toContain("Case #42 is open.");
		expect(JSON.stringify(stored?.[1])).toContain(SUBMITTED.caseId);
		expect(promptText(0)).toContain(SUBMITTED.caseId);
		expect(holdList()).toEqual([expect.objectContaining({ kind: "support", settled: true })]);
		// The same card approved again from another tab: answered, nothing reserved.
		const again = await postSupport(raw);
		expect(again.status).toBe(409);
		expect(await refusalOf(again)).toMatchObject({ refusal: "turn-answered" });
		expect(holdList()).toHaveLength(1);
	});

	it("a support-case output that fails its schema is a 400 before the hold", async () => {
		const a1 = caseProposal("a1", "p1");
		seedSupportThread([userMsg("u1", "open a case"), a1], { billingOrgId: ORG_A, revision: 3 });
		const raw = body([userMsg("u1", "open a case"), withOutput(a1, "p1", { status: "submitted", caseId: "not-a-uuid", caseNumber: 1 })], {
			turnId: "u1",
			baseRevision: 3,
			answerId: "a1",
			toolCallIds: ["p1"],
		});
		const res = await postSupport(raw);
		expect(res.status).toBe(400);
		expect(holdList()).toHaveLength(0);
	});

	it("a threaded request without orgId or turn is 409 client-outdated, not the threadless path", async () => {
		seedSupportThread([]);
		const res = await postSupport(JSON.stringify({ messages: [userMsg("u1", "hi")], threadId: THREAD }));
		expect(res.status).toBe(409);
		expect(await refusalOf(res)).toMatchObject({ refusal: "client-outdated" });
		const { assertAiAllowed } = await import("@/lib/billing/ai-guard");
		expect(assertAiAllowed).not.toHaveBeenCalled();
		expect(holdList()).toHaveLength(0);
	});

	it("a malformed orgId is 403 org-forbidden, and the resolver is never handed it", async () => {
		seedSupportThread([]);
		const res = await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }, { orgId: "not-a-uuid'::text" }));
		expect(res.status).toBe(403);
		expect(await refusalOf(res)).toMatchObject({ refusal: "org-forbidden" });
		const { resolveTurnActor } = await import("@/lib/authz/guard");
		expect(resolveTurnActor).not.toHaveBeenCalled();
		expect(world.reserveCalls).toBe(0);
	});

	it("an org the caller is not a member of is 403 org-forbidden before the hold", async () => {
		seedSupportThread([]);
		const res = await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }, { orgId: ORG_C }));
		expect(res.status).toBe(403);
		expect(world.reserveCalls).toBe(0);
		expect(holdList()).toHaveLength(0);
	});

	it("session on B, request names A: the hold and the tools are A's", async () => {
		seedSupportThread([]);
		model.scripts.push(callParts("list_projects", "r1", {}), speakParts("none"));
		const res = await postSupport(body([userMsg("u1", "my projects?")], { turnId: "u1", baseRevision: 1 }));
		await chunksOf(res);
		expect(world.sessionOrg).toBe(ORG_B);
		expect(world.toolActors).toEqual([ORG_A]);
		expect(holdList()[0]?.orgId).toBe(ORG_A);
	});

	it("a disconnect after model output reaches the model after a full GC: answered partial, billed at least the reserve", async () => {
		seedSupportThread([]);
		const ctl = new AbortController();
		const gate = deferred();
		model.scripts.push(gatedParts("The whole answer the user read", gate.promise));
		const res = await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }), ctl.signal);
		const seen = { text: false };
		const reading = readNoting(res, seen);
		await vi.waitFor(() => expect(seen.text).toBe(true));
		await collectAfterMacrotask();
		ctl.abort();
		await reading;
		await vi.waitFor(() => expect(claims()[0]?.state).toBe("answered"));
		expect(aborts()).toBe(1);
		expect(claims()[0]?.partial).toBe(true);
		expect(holdList()[0]?.credits).toBeGreaterThanOrEqual(100);
		gate.resolve();
	});

	it("a provider error before output: failed, hold 0, the turn stored unanswered", async () => {
		seedSupportThread([]);
		model.scripts.push(failingParts());
		await chunksOf(await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 })));
		expect(claims()[0]?.state).toBe("failed");
		expect(holdList()[0]).toMatchObject({ credits: 0, settled: true });
		expect(threads().get(THREAD)?.messages.map((m) => m.id)).toEqual(["u1"]);
	});

	it("a budget refusal answers 402 with the budget body", async () => {
		seedSupportThread([]);
		world.budgetRefused = true;
		const res = await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }));
		expect(res.status).toBe(402);
		expect(await res.json()).toMatchObject({ error: "Out of AI budget", upgradable: true });
	});

	it("the user's model pick reaches getAiModel", async () => {
		seedSupportThread([]);
		await chunksOf(await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }, { model: "anthropic/claude-opus-4-1" })));
		expect(world.modelPicks).toEqual(["anthropic/claude-opus-4-1"]);
	});
});

describe("the support route, for a request with no threadId: today's path, unchanged (§12)", () => {
	it("reserves one per-request support hold on the SESSION's org, streams, settles it from onFinish, stores nothing and never claims", async () => {
		model.scripts.push(speakParts("Here is how."));
		const res = await postSupport(JSON.stringify({ messages: [userMsg("u1", "how do I connect aws?")] }));
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("Here is how.");
		expect(text).not.toContain("data-turn-accepted");
		const { assertAiAllowed } = await import("@/lib/billing/ai-guard");
		const { recordAiUsage } = await import("@/lib/billing/ai-quota");
		const { currentActor } = await import("@/lib/authz/guard");
		expect(currentActor).toHaveBeenCalledTimes(1);
		expect(assertAiAllowed).toHaveBeenCalledTimes(1);
		expect(assertAiAllowed).toHaveBeenCalledWith(ORG_B, "support", USER);
		await vi.waitFor(() => expect(recordAiUsage).toHaveBeenCalledTimes(1));
		expect(recordAiUsage).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: ORG_B, userId: USER, kind: "support", holdId: "legacy-hold", model: "openai/test-model" }),
		);
		expect(world.reserveCalls).toBe(0);
		expect(world.finalizeCalls).toBe(0);
		expect(threads().size).toBe(0);
		expect(holdList()).toHaveLength(0);
		expect(promptText(0)).toContain("SUPPORT PERSONA");
		expect(offeredTools(0)).toEqual(["create_support_case", "list_projects"]);
	});

	it("a null threadId is threadless too, and a budget refusal there is 402 with the budget body", async () => {
		const { assertAiAllowed } = await import("@/lib/billing/ai-guard");
		const { AiBudgetError } = await import("@/lib/billing/ai-guard");
		vi.mocked(assertAiAllowed).mockRejectedValueOnce(new AiBudgetError("Out of AI budget", "out", null, true));
		const res = await postSupport(JSON.stringify({ messages: [userMsg("u1", "hi")], threadId: null }));
		expect(res.status).toBe(402);
		expect(await res.json()).toMatchObject({ error: "Out of AI budget", reason: "out", upgradable: true });
		expect(world.reserveCalls).toBe(0);
		expect(model.prompts).toHaveLength(0);
	});

	it("a disconnect after a full GC still reaches the model, and releases the per-request hold through onAbort", async () => {
		const ctl = new AbortController();
		const gate = deferred();
		model.scripts.push(gatedParts("Checking", gate.promise));
		const res = await postSupport(JSON.stringify({ messages: [userMsg("u1", "hi")] }), ctl.signal);
		const seen = { text: false };
		const reading = readNoting(res, seen);
		await vi.waitFor(() => expect(seen.text).toBe(true));
		await collectAfterMacrotask();
		ctl.abort();
		await vi.waitFor(() => expect(aborts()).toBe(1));
		await reading;
		const { releaseAiHold } = await import("@/lib/billing/ai-guard");
		await vi.waitFor(() => expect(releaseAiHold).toHaveBeenCalledTimes(1));
		gate.resolve();
	});

	it("still needs a session and a configured AI, before the hold", async () => {
		world.sessionUser = null;
		expect((await postSupport(JSON.stringify({ messages: [] }))).status).toBe(401);
		world.sessionUser = USER;
		world.aiConfigured = false;
		expect((await postSupport(JSON.stringify({ messages: [] }))).status).toBe(503);
		const { assertAiAllowed } = await import("@/lib/billing/ai-guard");
		expect(assertAiAllowed).not.toHaveBeenCalled();
	});
});

describe("the agent-identity route (slice 8)", () => {
	it("accepts through reserveTurn as an agent thread under the identity's prompt and tool scope, settling one agent hold", async () => {
		model.scripts.push(speakParts("Costs are flat."));
		const res = await postAgent(body([userMsg("u1", "costs?")], { turnId: "u1", baseRevision: 1 }, { mode: "act" }));
		expect(res.status).toBe(200);
		const chunks = await chunksOf(res);
		const types = chunks.map((c) => c.type);
		expect(types[0]).toBe("data-turn-accepted");
		expect(types.indexOf("data-turn-finished")).toBeLessThan(types.indexOf("finish"));
		const t = threads().get(THREAD);
		expect(t).toMatchObject({ kind: "agent", projectId: null, billingOrgId: ORG_A });
		expect(t?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(holdList()).toEqual([expect.objectContaining({ orgId: ORG_A, kind: "agent", settled: true, steps: 1 })]);
		expect(promptText(0)).toContain(PERSONA);
		expect(offeredTools(0)).toEqual(["list_projects"]);
		const { currentActor } = await import("@/lib/authz/guard");
		expect(currentActor).not.toHaveBeenCalled();
	});

	it("another org's agent is 404 before the hold, and its persona never reaches the response", async () => {
		const res = await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }), AGENT_B);
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain(PERSONA_B);
		expect(world.reserveCalls).toBe(0);
		expect(holdList()).toHaveLength(0);
		expect(model.prompts).toHaveLength(0);
	});

	it("a non-uuid agent id is the same 404", async () => {
		const res = await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }), "agent-1");
		expect(res.status).toBe(404);
		expect(world.reserveCalls).toBe(0);
	});

	it("the identity is read under the BILLING org: an org-scoped agent of A named from a thread pinned to B is 404", async () => {
		world.agents.set(AGENT, { id: AGENT, user_id: OTHER_USER, org_id: ORG_A, project_id: null, persona: PERSONA, mission: "m", tool_scope: [] });
		seedThread([], { billingOrgId: ORG_B });
		const res = await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }));
		expect(res.status).toBe(404);
		expect(world.reserveCalls).toBe(0);
	});

	it("an identity bound to a project: the thread is that project's, and a project outside the billing org is 404 project-not-found", async () => {
		model.scripts.push(speakParts("ok"));
		await chunksOf(await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }), AGENT_P));
		expect(threads().get(THREAD)?.projectId).toBe(PROJECT);
		expect(holdList()).toHaveLength(1);

		world.threads = new Map();
		world.agents.set(AGENT_P, { id: AGENT_P, user_id: USER, org_id: ORG_A, project_id: PROJECT_B, persona: PERSONA, mission: "m", tool_scope: [] });
		const res = await postAgent(body([userMsg("u2", "hi")], { turnId: "u2", baseRevision: 1 }), AGENT_P);
		expect(res.status).toBe(404);
		expect(await refusalOf(res)).toMatchObject({ refusal: "project-not-found" });
		expect(holdList()).toHaveLength(1);
	});

	it("an org the caller is not a member of is 403 org-forbidden before the identity is read", async () => {
		const res = await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }, { orgId: ORG_C }));
		expect(res.status).toBe(403);
		expect(await refusalOf(res)).toMatchObject({ refusal: "org-forbidden" });
		expect(world.reserveCalls).toBe(0);
	});

	it("a request without orgId or turn is 409 client-outdated; one without a threadId is a 400", async () => {
		const outdated = await postAgent(JSON.stringify({ messages: [userMsg("u1", "hi")], threadId: THREAD }));
		expect(outdated.status).toBe(409);
		const noThread = await postAgent(JSON.stringify({ messages: [userMsg("u1", "hi")], orgId: ORG_A, turn: { trigger: "submit-message", turnId: "u1", baseRevision: 1 } }));
		expect(noThread.status).toBe(400);
		expect(world.reserveCalls).toBe(0);
	});

	it("two Retries of one turn: one model call, one hold, the second answers turn-in-progress", async () => {
		const gate = deferred();
		model.scripts.push(gatedParts("Looking", gate.promise));
		const raw = body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 });
		const reading = chunksOf(await postAgent(raw));
		await vi.waitFor(() => expect(model.prompts).toHaveLength(1));
		const second = await postAgent(raw);
		expect(second.status).toBe(409);
		expect(await refusalOf(second)).toMatchObject({ refusal: "turn-in-progress" });
		gate.resolve();
		await reading;
		expect(holdList()).toHaveLength(1);
		expect(claims()[0]?.state).toBe("answered");
	});

	it("a disconnect after model output reaches the model after a full GC: answered partial, billed at least the reserve", async () => {
		const ctl = new AbortController();
		const gate = deferred();
		model.scripts.push(gatedParts("The whole answer the user read", gate.promise));
		const res = await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }), AGENT, ctl.signal);
		const seen = { text: false };
		const reading = readNoting(res, seen);
		await vi.waitFor(() => expect(seen.text).toBe(true));
		await collectAfterMacrotask();
		ctl.abort();
		await reading;
		await vi.waitFor(() => expect(claims()[0]?.state).toBe("answered"));
		expect(aborts()).toBe(1);
		expect(claims()[0]?.partial).toBe(true);
		expect(holdList()[0]?.credits).toBeGreaterThanOrEqual(100);
		gate.resolve();
	});

	it("a throw in the tool build after acceptance: the claim is failed, the hold is 0, and a Retry re-arms", async () => {
		world.throwInTools = true;
		const raw = body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 });
		await expect(postAgent(raw)).rejects.toThrow("buildAgentTools failed");
		expect(claims()[0]?.state).toBe("failed");
		expect(holdList()[0]).toMatchObject({ credits: 0, settled: true });
		world.throwInTools = false;
		model.scripts.push(speakParts("ok"));
		await chunksOf(await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 2 })));
		expect(claims()[0]).toMatchObject({ attemptNo: 2, state: "answered" });
	});

	it("a throw inside the stream's execute before the model emits: failed, hold 0, heartbeat cleared", async () => {
		world.throwInStream = true;
		await chunksOf(await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 })));
		await vi.waitFor(() => expect(claims()[0]?.state).toBe("failed"));
		expect(holdList()[0]).toMatchObject({ credits: 0, settled: true });
	});

	it("a heartbeat after expiry aborts the model, and the lost finalize stores and settles nothing", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const gate = deferred();
		model.scripts.push(gatedParts("Thinking", gate.promise));
		const res = await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }));
		const seen = { text: false };
		const reading = readNoting(res, seen);
		await vi.waitFor(() => expect(seen.text).toBe(true));
		const c = claims()[0];
		if (!c) throw new Error("no claim");
		c.state = "expired";
		await vi.advanceTimersByTimeAsync(30_000);
		await reading;
		expect(aborts()).toBe(1);
		expect(world.events).toContain("finalize:lost");
		expect(holdList()[0]?.settled).toBe(false);
		gate.resolve();
	});
});

describe("the shared route body's remaining arms, through the slice 8 routes", () => {
	it("finalizes an attempt once: a throw in execute after finalize reaches onError, which does not finalize again", async () => {
		seedSupportThread([]);
		world.holdThrows = true;
		model.scripts.push(speakParts("ok"));
		await chunksOf(await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 })));
		await vi.waitFor(() => expect(claims()[0]?.state).toBe("answered"));
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 20);
		});
		expect(world.finalizeCalls).toBe(1);
		expect(holdList()[0]).toMatchObject({ settled: true, steps: 1 });
	});

	it("an actor the resolver answers for another user is refused 403, and nothing is reserved", async () => {
		seedSupportThread([]);
		world.foreignActor = true;
		const res = await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }));
		expect(res.status).toBe(403);
		expect(await refusalOf(res)).toMatchObject({ refusal: "org-forbidden" });
		expect(world.reserveCalls).toBe(0);
		const agent = await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }));
		expect(agent.status).toBe(403);
		expect(world.reserveCalls).toBe(0);
	});

	it("a pin written by a racing first turn: the gate re-runs for the pinned org, and the support turn bills there", async () => {
		seedSupportThread([], { billingOrgId: ORG_B });
		world.pinReadMisses = true;
		model.scripts.push(speakParts("ok"));
		const res = await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }));
		expect(res.status).toBe(200);
		await chunksOf(res);
		expect(world.reserveCalls).toBe(2);
		expect(holdList()).toEqual([expect.objectContaining({ orgId: ORG_B, kind: "support", settled: true })]);
	});

	it("the agent identity is read again under the pinned org when the pin moved", async () => {
		seedThread([], { billingOrgId: ORG_C });
		world.pinReadMisses = true;
		world.memberships.get(USER)?.add(ORG_C);
		const res = await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }));
		// AGENT is ORG_A's and the caller's own row, so it is readable under ORG_C through its user arm.
		expect(res.status).toBe(200);
		await chunksOf(res);
		expect(holdList()[0]?.orgId).toBe(ORG_C);
		// An identity that is only ORG_A's (another user's row) is not readable under the pinned ORG_C.
		world.agents.set(AGENT, { id: AGENT, user_id: OTHER_USER, org_id: ORG_A, project_id: null, persona: PERSONA, mission: "m", tool_scope: [] });
		const again = await postAgent(body([userMsg("u1", "hi"), { id: "a", role: "assistant", parts: [{ type: "text", text: "ok" }] }, userMsg("u2", "more")], { turnId: "u2", baseRevision: 3 }));
		expect(again.status).toBe(404);
		expect(holdList()).toHaveLength(1);
	});

	it("a finalize that throws is logged; the stream still finishes and no data-turn-finished is written", async () => {
		seedSupportThread([]);
		world.finalizeThrows = true;
		const chunks = await chunksOf(await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 })));
		const types = chunks.map((c) => c.type);
		expect(types).toContain("finish");
		expect(types).not.toContain("data-turn-finished");
		const { log } = await import("@/lib/observability/log");
		expect(log.error).toHaveBeenCalledWith("turn finalize failed", expect.anything());
		expect(claims()[0]?.state).toBe("running");
	});

	it("a heartbeat that throws is logged and does not stop the turn", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		world.heartbeatThrows = true;
		const gate = deferred();
		model.scripts.push(gatedParts("Thinking", gate.promise));
		const res = await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 }));
		const seen = { text: false };
		const reading = readNoting(res, seen);
		await vi.waitFor(() => expect(seen.text).toBe(true));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(world.heartbeats).toBe(1);
		const { log } = await import("@/lib/observability/log");
		await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith("turn heartbeat failed", expect.anything()));
		gate.resolve();
		await reading;
		expect(aborts()).toBe(0);
		expect(claims()[0]?.state).toBe("answered");
	});

	it("the support turn runs one model with no extended thinking; the identity's runs with it on every step", async () => {
		seedSupportThread([]);
		await chunksOf(await postSupport(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 })));
		expect(model.options[0]?.providerOptions).toBeUndefined();
		world.threads = new Map();
		world.claims = [];
		model.scripts.push(callParts("list_projects", "r1", {}), speakParts("none"));
		await chunksOf(await postAgent(body([userMsg("u1", "hi")], { turnId: "u1", baseRevision: 1 })));
		expect(model.options).toHaveLength(3);
		expect(model.options[1]?.providerOptions?.anthropic).toBeDefined();
		expect(model.options[2]?.providerOptions?.anthropic).toBeDefined();
	});
});
