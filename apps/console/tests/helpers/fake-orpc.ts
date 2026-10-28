// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for `orpc` from `@/lib/rpc/client` in component and hook tests: the same key shape
// (`[path, { input, type }]`, prefix `[path]`) and the same `queryOptions` / `infiniteOptions` /
// `key` surface, with each procedure answered by a handler the test supplies. A procedure with no
// handler throws when READ, so a test cannot pass by silently fetching nothing.
//
//   const h = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler>, calls: [] as FakeCall[] }));
//   vi.mock("@/lib/rpc/client", async () => {
//     const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
//     return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
//   });
//
// `handlers` is read at READ time, so a test may set or replace a handler after the mock is built.

/** Answers one procedure's input. */
export type FakeHandler = (input: unknown) => Promise<unknown>;

/** Options a test passes through to TanStack untouched (enabled, staleTime, …). */
type Passthrough = Record<string, unknown>;

/** One read the fake served: the dotted procedure path and its input. */
export interface FakeCall {
	path: string;
	input: unknown;
}

/** The fake client plus the log of every read it served. */
export interface FakeOrpc {
	orpc: unknown;
	/** Every read, in order. */
	calls: FakeCall[];
}

/** Builds a proxy-shaped fake `orpc` over `handlers`, keyed by dotted procedure path. */
export function fakeOrpc(
	handlers: Record<string, FakeHandler>,
	calls: FakeCall[] = [],
): FakeOrpc {
	const read = (path: string, input: unknown) => {
		calls.push({ path, input });
		const handler = handlers[path];
		if (!handler) throw new Error(`fakeOrpc: no handler for ${path}`);
		return handler(input);
	};
	const node = (segments: string[]): unknown =>
		new Proxy(
			{},
			{
				get(_target, prop) {
					// Not a thenable: something awaiting a node must not see a `then` procedure.
					if (typeof prop !== "string" || prop === "then") return undefined;
					const path = segments.join(".");
					if (prop === "key") return () => [segments];
					// A procedure with no input is called with no argument (`queryOptions()`), as on oRPC.
					if (prop === "queryKey") {
						return ({ input }: { input?: unknown } = {}) => [segments, { input, type: "query" }];
					}
					if (prop === "queryOptions") {
						return ({ input, ...rest }: { input?: unknown } & Passthrough = {}) => ({
							queryKey: [segments, { input, type: "query" }],
							queryFn: () => read(path, input),
							...rest,
						});
					}
					if (prop === "infiniteOptions") {
						return ({
							input,
							...rest
						}: { input: (pageParam: unknown) => unknown } & Passthrough) => ({
							queryKey: [segments, { input: input(undefined), type: "infinite" }],
							queryFn: ({ pageParam }: { pageParam: unknown }) => read(path, input(pageParam)),
							...rest,
						});
					}
					return node([...segments, prop]);
				},
			},
		);
	return { orpc: node([]), calls };
}
