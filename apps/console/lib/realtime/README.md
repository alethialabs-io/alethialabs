# Live updates in the console

How a page shows a change it did not make. This is the convention (#6757); the design behind it is
`docs/adr/0005-console-data-architecture.md` (D3, §7 Q3, §10 R7), and the client half of the query
side is `apps/console/lib/query/README.md`.

There are two kinds of live data, and each has exactly one reader:

| Kind | What it carries | Reader |
|---|---|---|
| The org's **change stream** | "something in this family of rows changed" — a topic, sometimes a row id, never the data | `components/shell/realtime-mount.tsx`: one stream per browser, shared by its tabs |
| A **per-resource stream** | the data itself, for one resource: a job's log lines | `hooks/use-event-stream.ts` — `useEventStream(url)` |

## The four rules

### 1. Data that changes without the viewer's action is a client query under a key a topic invalidates

Read it with a query hook, and list its key under its topic in `TOPIC_KEYS`
(`lib/query/topics.ts`). The topics are the `TOPICS` list in `lib/realtime/topics.ts`. A hint on a
topic invalidates that topic's keys, and only queries that are on screen refetch, through the same
authorised read as the first paint.

Props passed from a server component are for data that does not change while the page is open. A
list handed down as props never hears a hint: it is right at first paint and stale from then on.
Prefetch on the server and hydrate the query instead (`lib/query/README.md`, "The pattern").

Do not set `refetchInterval`, and do not re-read on a `setInterval`. While the change stream is
down, the one sanctioned poll (`lib/realtime/client/fallback-poll.ts`) refreshes every topic's keys.

### 2. A per-resource stream is read with `useEventStream(url)`

```tsx
const { state, reconnect } = useEventStream(done ? null : streamUrl, { onMessage });
```

`state` is one of four values, and each has one meaning for the page:

| State | Meaning | What the page shows |
|---|---|---|
| `connecting` | a request is out, or the next automatic attempt is scheduled | what it showed before; nothing new |
| `open` | the server answered with an event stream | nothing; the data is the sign |
| `closed` | nothing more will arrive until `reconnect()` is called | "Live log disconnected — Reconnect" (the noun is the page's), with `reconnect` on the button |
| `signed-out` | the session is gone | nothing — see "Session end" below |

A stream that fails or drops is tried again up to five times with backoff, resuming after the last
message id it saw (`Last-Event-ID`). It reads `closed` when those attempts run out, or at once when
the server answers 403 or 404. A stream that delivered anything starts the count again.

**A resource that will send nothing more gets no stream.** Pass `null` as the address for a finished
job or an ended turn. No request is made and `state` is `null`, so nothing reads "disconnected" for
a resource that simply ended.

A route that serves such a stream:

- answers `401` with no session, and `403` or `404` for a resource the reader may not see;
- sends each message with an `id:` and resumes after the `Last-Event-ID` request header;
- sends a comment frame (`:\n\n`) at least every 20 seconds — the hook takes 45 seconds of silence
  for a dead connection and opens the stream again.

Do not construct an `EventSource` in a component or a hook. It stops for good on any answer but 200
and does not show the status, so a session that ended, a resource that is gone and a server restart
cannot be told apart.

### 3. A wait on a job reads the `jobs` topic

A flow that starts a job and waits for it (a kubeconfig mint, a scan) reads the job through a query
under a key the `jobs` topic invalidates — `orpc.jobs.status`, for example — and reacts when the
status changes. No `await sleep()` loop over a server action, and no recursive `setTimeout`:
`check:no-polling` cannot see either, which is why this is a rule and not only a guard.

When what the wait reads cannot be a query — reading a kubeconfig mint COLLECTS it, so the read is
a write — the wait is a Query entry with no fetcher under a key the topic invalidates, and the flow
reads again each time that entry is invalidated. `components/clusters/kubeconfig-download/mint-wait.ts`
is that shape: it re-arms the entry before each read so a hint that lands during a read is not lost,
and it is bounded by the request's own window.

### 4. Every poll that is left names the unit that lifts it

`apps/console/no-polling-ledger.json` lists every `setInterval` and `refetchInterval` in the console:
the one `sanctioned` poll, the `timers` that read no data (each with its `reason`), and the `polls`
that are still data polls. Each entry under `polls` carries `"lifts": "#NNNN"`, an open issue whose
scope includes that file. `"unassigned"` is not allowed.

Two things enforce this:

- `pnpm -C apps/console run check:no-polling` (`scripts/check-no-polling.mjs`) fails on an interval
  that is not in the ledger, on an entry that is no longer in the tree, and on a poll count that
  grew against `origin/dev`. Its own `lifts` rule still accepts the word `unassigned`.
- `tests/hooks/use-event-stream.test.tsx` (its last block) fails on a `lifts` that is not an issue
  number.

## Session end

One store says whether this tab's session is still good: `lib/stores/use-session-state.ts`. One
surface shows it: `components/shell/session-ended.tsx`. Live updates meet it in three places, and
none of them renders anything of its own for a session that ended:

- The change stream reaching `signed-out` ends the session (`components/shell/realtime-mount.tsx`).
- `useEventStream` ends the session when its stream answers `401`, and reads `signed-out`. When any
  other source ends the session first, the hook closes its stream and reads `signed-out` too, so a
  stream is never retried into a refusal.
- The fallback poll stops once the session has ended.

## Live surfaces and who owns them

The surfaces this convention was written against, and the open unit that brings each one to it. A
row leaves this table in the PR that closes it.

| Surface | Today | Rule | Owner |
|---|---|---|---|
| Job log (`hooks/use-job-log-stream.ts`) | reads with `EventSource`; a failed stream is not shown, and a finished job still opens one | 2 | #6818 |
| Paid-setup settling state (`components/org/pending-paid-setup.ts`) | a 3-second interval | 4 | #7004 |
| "Being answered" wait (`components/agent/elench/elench-conversation.tsx`) | an interval over `getThread` | 4 | #7005 |
| Elench drafts list (`lib/stores/elench-drafts/store.ts`) | a 60-second interval while the surface is open | 4 | #7006 |

`useEventStream` has no caller yet: this unit defines it, and #6818 moves the job log onto it.
