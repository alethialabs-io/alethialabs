<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# A chat turn is answered by the model, and billed, exactly once

**Status:** proposed (2026-10-06, revision 3; revision 1 was 09021e23f, revision 2 was 4a8e15518) · **Issue:** #5515 · **Builds on:** ADR 0001 revision
5.1 (#5512, draft persistence), whose §5.3 defines the hand-off this ADR takes over · **Related:**
ADR 0002 (#5511, payment holds; a different "hold": that one is a Stripe first payment, this one is
the AI budget hold in `ai_usage_ledger`)

**Decision (proposed).**

1. **A turn is named by its user message's id.** The client mints it (ADR 0001 mints it at the
   draft claim and never re-mints it for a stored turn). The server never mints a turn id. It mints
   the **answer id** (the assistant message id) and the **attempt token**.
2. **A model call is an attempt, and an attempt is a row.** A new table, `agent_turn_claims`, holds
   one row per `(thread id, turn id, attempt key)`. The attempt key says which model call this is:
   the first answer of the turn, a regenerate of one named answer, or the continuation of one named
   answer after its client tool calls resolved (§4.1). At most one attempt per thread is `running`.
3. **Acceptance is one transaction.** Under the org's existing AI-budget advisory lock and the
   thread row's lock, the route checks the turn, inserts or re-arms the claim, reserves the budget
   hold, and appends the user turn to the stored transcript. All of it commits, or none of it does.
   A request refused by the claim never reaches `assertAiAllowed`'s reserve, so **a second request
   for one turn reserves no hold** (§5).
4. **The billing org is pinned on the thread at its first turn** (Q1). The first turn bills to the
   org the request names, resolved strictly two-way (the named org, or the caller's personal org
   when that is what it names), never the session's active org. Every later turn, Retry,
   regenerate and continuation of that thread bills to, and runs its tools in, the pinned org,
   whichever tab sends it, and is refused if the caller is no longer an active member (§6).
5. **The stored transcript is the history.** The route builds the model's input from the stored
   row, takes only the new user message (or the resolved tool outputs) from the request, and saves
   by **appending** under a compare-and-set on a new `agent_threads.revision`. A tab that sends from
   an older revision is refused before the hold and loads the transcript (§7).
6. **An answer is billed if and only if it is stored, and at most one answer is stored per attempt
   key.** The hold is settled **inside** the transaction that wins the `running → answered`
   compare-and-set, so no crash can leave a stored answer with an unsettled hold; a lost or expired
   attempt releases it to 0 (§8).
7. **The route bounds itself.** `maxDuration` bounds nothing in this deployment, so the route
   merges an `AbortSignal.timeout` into the model call and renews the claim's lease by heartbeat.
   The lease measures silence, as ADR 0001's draft lease does (§8.2). The existing
   `release-ai-holds` sweep is extended to expire silent claims; there is no second sweep (Q5).
8. **This ADR changes four things in ADR 0001**, listed in §9.4. The one that matters most: a
   re-send whose text differs from the stored turn is refused `turn-committed-different-text`, and
   ADR 0001 releases the draft with a fresh turn id instead of consuming it, so typed text is never
   lost (Q3).

**Why.** Today the chat routes have no notion of a turn. The hold's `refId` is the thread id
(`app/api/agent/route.ts:220-225`), every request reserves its own hold (`:201`), the saved
transcript is whatever list the client sent (`:281-282`, `:376-383`), and the billing org is the
session's (`:171`). Each of the twelve cases in #5515 is one of those four facts meeting a second tab,
a second device, a reload, a Retry or an approval card. A table of states written first (#5512
revision 3) missed four of them in one review, so this ADR starts from the cases (§2) and derives the
state machine from them.

---

## 1. Context: what the code does today (origin/dev @ f586e91e5)

Every statement below was read at `f586e91e5`. None of the files it cites changed between
`fbe2409c8` (where #5515 and ADR 0001 verified their facts) and `f586e91e5`. Paths are relative to
`apps/console/` unless they start with `ee/` or `node_modules/`.

**The routes.** Three routes answer a chat turn from a console surface, and a fourth is metered the
same way:

| Route | Hold | Transcript save | Callers in the console |
|---|---|---|---|
| `app/api/agent/route.ts` (Elench, org) | `:201` | `:376-383` | `components/agent/elench/elench-conversation.tsx:153-156` |
| `app/api/projects/[projectId]/assistant/route.ts` (Elench, project) | `:205` | `:375-382` | the same, `:156` |
| `app/api/agent/[agentId]/route.ts` (an agent identity) | `:96` | `:199-203` | none found |
| `app/api/support/ask/route.ts` (support) | `:52` | `:140` | `components/support/ask/support-ask-chat.tsx:28-30` |

#5515's scope names the first two. §12 says what happens to the other two.

**The hold.**
- `assertAiAllowed` (`lib/billing/ai-guard.ts:224`) is the only reserve. For a metered kind it
  takes `pg_advisory_xact_lock(hashtext('ai_budget'), hashtext(orgId))` on a service-role
  transaction (`:322`), re-reads the window, and inserts a provisional ledger row of
  `METERED_RESERVE_CREDITS = 100` (`:375-390`). The row's id is the `holdId`.
- Without hosted billing it returns `{ source: "included", credits: 0 }` and reserves nothing
  (`:229`).
- The hold is reconciled in place by `recordAgentTurnUsage`, whose row 0 updates `holdId` and whose
  further rows **append** (`lib/billing/agent-metering.ts:99-148`, row 0 at `:141`). It is released to 0 by
  `releaseAiHold` (`ai-guard.ts:96-110`) from `onAbort` (`route.ts:370-372`) and from the pre-stream
  `catch` (`:387-391`), and to 0 by `onError` (`:350-367`, no tokens).
- Nothing identifies the turn. `refId` is the thread id (`route.ts:220-225`) or the project id
  (`assistant/route.ts:224-229`). Two requests for one turn reserve two holds and settle two.
- **A stranded hold is released by a sweep.** `release-ai-holds` (`lib/reconcile/ai-holds.ts`,
  #2683, #3177) runs every 15 minutes on the reconcile loop (`lib/reconcile/loop.ts:49`,
  `:125-126`) and releases to 0 every ledger row with `settled_at IS NULL` older than
  `STRANDED_HOLD_AGE_MINUTES = 60`. A crashed turn's hold therefore stays at the reserve for 60 to
  75 minutes, then reads 0. The settle that reaches the row later overwrites it in place: the
  reconcile `UPDATE` matches the row by id alone (`lib/billing/ai-quota.ts:318-338`), with no
  `settled_at` guard.
- **The sweep's window is derived from a bound that does not exist.** `ai-holds.ts:27-37` says a
  turn is bounded by `stepCountIs(8)` and by "the platform's function timeout". There is no such
  timeout here (see **Duration** below). Every caller of `assertAiAllowed` is unbounded in time: the
  four routes of the table above, and the server actions `colony.ts:85` and `verify.ts:44`
  (`scanner.ts:44` takes the fixed `scan` charge, which writes no hold row, `ai-guard.ts:263-290`). The same comment says that releasing a live turn's hold early "books the cost
  twice". It does not: the late settle overwrites the row in place, so the turn is billed once and
  only the window's headroom is wrong in between. §8.2 corrects both statements.

**Disconnect and abort.** `streamText` takes `abortSignal: req.signal` (`route.ts:293`). On abort it
calls `onAbort({ steps: recordedSteps })` with the **completed** steps only
(`node_modules/.pnpm/ai@6.0.279_zod@4.5.4/node_modules/ai/dist/index.mjs:7652`), and the route
releases the hold to 0. The UI-message stream's `onFinish` still runs, with `isAborted: true`
(`index.mjs:6487-6489`), so the **partial** answer is saved. Today a turn whose text streamed in
full to a client that then disconnected before the last step finished is stored and billed 0.

**The transcript.** `createUIMessageStream({ originalMessages: messages })` takes the client's list
(`route.ts:281-282`), and `onFinish` saves `[...originalMessages, answer]` (`index.mjs:6490-6494`)
through `saveThreadTranscript` (`lib/agent/thread-transcript.ts:95-110`), whose `updateLive` sets
`messages` wholesale (`thread-transcript.ts:27-41`; `lib/agent/transcript-save.ts:121`). A tombstone
sends the list into a "Recovered: …" thread (`transcript-save.ts:123-137`). A missing row is
recreated under its id for `agent` threads (`:145-158`). The row has no revision.

**The client.**
- `useAgentChat` returns its own body from `prepareSendMessagesRequest: ({ messages }) => ({ body:
  { messages, ...prepareBody } })` (`components/agent/use-agent-chat.ts:61-63`), which drops the
  `trigger` and `messageId` the transport passes in (`index.mjs:14158-14159`).
- `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls` (`use-agent-chat.ts:75`).
  When an approval card resolves, `addToolOutput` sends `makeRequest({ trigger: "submit-message",
  messageId: lastMessage.id })` with the **assistant** message last (`index.mjs:14424-14433`). The
  predicate fires when every non-provider tool part of the **last step** has an output
  (`index.mjs:14770-14786`).
- Regenerate and Retry are both `regenerate()` with no id (`elench-conversation.tsx:302`, `:464`).
  `regenerate()` slices the transcript before it calls `makeRequest`, so the answer it replaces is
  no longer in the request (`index.mjs:14340-14358`). The Regenerate action is shown only on the
  last message (`components/agent/agent-chat.tsx:376`).
- Mentions travel in `body.mentions` from the `pendingMentions` slot (`elench-conversation.tsx:157-194`,
  `:247`). The cell target travels in `body.cellTarget` (`:172`).

**Tenancy.**
- Both routes call `currentActor()` (`route.ts:171`; `assistant/route.ts:181`). It takes no argument
  (`lib/authz/guard.ts:27`). For `/api/**` the address names no org, so it answers
  `getActiveScope(userId, activeOrgId)` from the session (`guard.ts:38`). A tab on org A whose session
  was switched to B in another tab runs A's turn under B.
- The project assistant reads the project under that actor, and a nested call resolves it again:
  `resolveActiveEnvironmentId` calls `currentActor()` itself (`app/server/actions/resolve.ts:149`),
  and so does every server action a tool calls. Nothing checks that `projectId` belongs to the
  actor's org before the hold (`assistant/route.ts:180-219`).
- In enterprise, `resolveActiveScope` answers a named org the caller is not an active member of with
  the earliest active membership, else the personal org (`ee/src/scope.ts:68-94`). `currentActor()`'s
  second arm accepts the personal answer (`guard.ts:65`). **A named-org resolver already exists**:
  `resolveNamedOrgScope` is strictly two-way (`guard.ts:154-160`), and `authorizeInOrg` wraps it with
  a PDP check (`guard.ts:180-199`). Neither chat route uses it.
- `runWithActor(actor, fn)` binds an actor for everything `fn` awaits, and `currentActor()` prefers
  it (`lib/authz/actor-context.ts:25-32`; `guard.ts:28-29`).

**Threads and RLS.**
- `createThread` writes `org_id: owner` (`app/server/actions/agent.ts:97`), so org-level threads are
  user-scoped and listed in every org. `agent_threads` is in the `owner_all` OR loop
  (`lib/db/programmables.sql:1127`).
- `deleteThread` deletes the row and inserts a tombstone under the same id (`agent.ts:195-217`).
  `listThreads` reaps tombstones after a day and empty rows after an hour (`agent.ts:128-143`).
- Postgres does not apply row security when it checks a foreign key or runs a referential action
  (CREATE POLICY, "Notes"). A foreign key from a claim to `agent_threads(id)` therefore proves the
  thread **exists**, not that the caller **owns** it. #5515 case 8 suggests the opposite; §4.3
  corrects it.

**Duration.** The console ships as `output: "standalone"` (`next.config.ts:35`) and runs as
`node apps/console/server.js` (`Dockerfile:87`). There is no `vercel.json`. The `maxDuration`
exports (`assistant/route.ts:51`, `app/api/agent/[agentId]/route.ts:33`, `app/api/mcp/route.ts:19`)
bound nothing, and `/api/agent` has none. A turn runs up to `stepCountIs(8)` (`route.ts:295`); a
deep-reasoning turn has been measured at six minutes (#5512 thread 4177659595). The comment at
`agent.ts:119-123` reasons from "the chat routes' `maxDuration` is 300s".

## 2. The cases

Each case is stated as the failure it names. §11 gives each one a mechanism and a test.

| # | Case (source) | What goes wrong today |
|---|---|---|
| 1 | Failed `startThread`, Retry bills twice (#5423 4173024467) | A committed-but-unattached first turn is sent again; two holds, two answers |
| 2 | Duplicated tab retries an answered turn (G1, 4177444315) | Answered and billed twice; B's save erases A's reply |
| 3 | Session org bills the turn (G5, 4177444337) | Tab on A, session switched to B: A's turn billed to B and run with B's data |
| 4 | Project not checked before the hold (A2) | A project id from another org reaches the hold and the model |
| 5 | Two attempts at one turn reach the model (G18, 4177527060) | No claim exists |
| 6 | A stale tab's new turn replaces newer turns (#5512 §12, Q8, A5) | `originalMessages` is saved wholesale |
| 7 | HITL continuation (4177659589) | A claim on the last user message refuses the approval; or the auto-send races the save |
| 7b | HITL continuation from a mixed step (review of revision 1) | The model calls a server tool (a read such as `list_projects`) and `propose_operation` in one step. A continuation key that names the server tool, whose output is already stored, is refused, and plan → deploy dies as in case 7 |
| 8 | Claim key vs RLS (4177659592) | A global key under an org-AND policy is invisible to, and collides with, the other org; delete cannot remove it |
| 9 | `maxDuration` is not a bound (4177659595) | A lease sized from it expires under a live six-minute turn; a Retry re-claims |
| 10 | Named-org resolver (4177659598) | `currentActor()` cannot take an org; the enterprise fallback lands a removed member on their personal org |
| 11 | Regenerate re-bills by design | A stale tab can regenerate an answer it never displayed |
| 12 | The client half of a refusal (ADR 0001 D20) | A refused tab shows an error card instead of the stored transcript |
| 13 | Addendum: mentions, `trigger`, `messageId` (G12, 4177527031) | Mentions ride a global slot; the transport drops `trigger` and `messageId` |

Found while reading the code for this ADR:

| # | Case | What goes wrong today |
|---|---|---|
| 14 | Stream, then disconnect | A fully streamed answer whose last step had not finished is stored and billed 0 (§1) |
| 15 | Nested `currentActor()` | Even with a named billing org, the project's environment and every tool would resolve the session's org |
| 16 | A crashed process | The hold stays at the 100-credit reserve with no answer until `release-ai-holds` releases it to 0, 60 to 75 minutes later (§1) |
| 17 | Auto-send before the save | The client sees `finish` before `onFinish` has saved, so a continuation can arrive before the answer is stored |
| 18 | Thread deleted mid-turn | Covered today by the tombstone; a claim with `ON DELETE CASCADE` disappears under a running attempt |
| 19 | Re-send of a stored, unanswered turn with edited text | Which text is answered: the stored one or the edit? And the edit must not be lost (ADR 0001's invariant) |
| 20 | Two tabs send **different** new turns at one base | Both answer; the second save erases the first |
| 21 | An open tab running the old bundle after the deploy | It sends no org, no revision, no trigger |

## 3. Vocabulary

- **Turn**: one user message in one thread. Its **turn id** is the message's id, minted by the
  client. ADR 0001 mints it at the draft claim (D9, D10) and stores it as `claim_turn_id`; a first
  turn stores it as `messages[0].id`. A surface without ADR 0001 gets it from `useChat`'s
  `generateId` when the message is pushed. Either way it is fixed for the life of the message.
- **Answer**: the assistant message that follows a turn in the stored transcript. Its **answer id**
  is minted by the route (`generateMessageId` on `toUIMessageStream`, `index.mjs:8687`). A
  continuation extends the same answer and keeps its id (`isContinuation`, `index.mjs:6485`).
- **Attempt**: one model call for one turn. Its **attempt key** is one of:
  - `answer`: the turn's first answer, or a Retry of a turn with no stored answer;
  - `regen:<answer id>`: a regenerate of that stored answer;
  - `continue:<answer id>:<tool call ids>`: the continuation of that answer after its **pending
    client tool calls** received outputs. The ids are sorted and joined with `,`.
- **Client tool**: a tool the route declares without `execute`, so its output can only come from
  the browser (`addToolOutput`). Today that is `propose_operation` alone
  (`components/agent/render-tool-parts/org-tool-parts.tsx:48-66`); every read tool executes on the
  server (`lib/ai/TOOLS.md`). The list is one exported constant, `CLIENT_TOOL_NAMES` in
  `lib/ai/client-tools.ts`, imported by both routes' tool sets and by the transport.
- **Pending client tool calls of an answer `a`**: the tool parts of `a`'s **last step** (the parts
  after its last `step-start`) whose tool name is in `CLIENT_TOOL_NAMES` and which are not
  `providerExecuted`. The client and the server compute this set with **one function**,
  `pendingClientToolCalls(message)` in `lib/agent/turn-key.ts`, over the same stored `a`: the
  client over its copy (which the transcript load or the stream gave it), the server over the
  locked row. A server-executed tool in the same step is never in the set, whether or not its
  output is stored, so a step that holds `list_projects` and `propose_operation` names only the
  proposal (case 7b).
- **Claim**: the `agent_turn_claims` row of an attempt key (§4).
- **Acceptance**: the commit of `reserveTurn` (§5). It is ADR 0001's **hand-off** for a later turn:
  the route answers 2xx only after it.
- **Revision**: `agent_threads.revision`, which goes up by one on every write to `messages`.
- **Base revision**: the revision of the transcript the requesting tab holds.
- **Model output**: a text, reasoning or tool part written by the model. The route's own
  `data-agent-step` markers are not model output.

## 4. Data model

### 4.1 `agent_turn_claims`

In `lib/db/schema/agent.ts`, beside `agentThreads`:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, `defaultRandom()` | never sent by a client |
| `thread_id` | `uuid` not null, FK `agent_threads(id)` `ON DELETE CASCADE` | §4.3 |
| `user_id` | `uuid` not null | the thread's owner; the RLS column |
| `turn_id` | `text` not null | the user message id; zod: 1-128 chars of `[A-Za-z0-9_-]` |
| `attempt_key` | `text` not null | §3 |
| `state` | `text` not null: `running` · `answered` · `failed` · `expired` | §5 |
| `token` | `uuid` not null | minted per attempt by the route; fences a late finalize |
| `attempt_no` | `integer` not null default 1 | +1 each time a `failed`/`expired` row is re-armed |
| `billing_org_id` | `uuid` not null | a copy of the thread's pinned org (§4.2, §6) at acceptance. Data, not visibility |
| `project_id` | `uuid` null | a copy of the thread's project, or null for an org thread |
| `hold_id` | `uuid` null | `ai_usage_ledger.id`; null without hosted billing |
| `accepted_revision` | `integer` not null | the thread's revision after acceptance |
| `answer_id` | `text` null | set with `answered` |
| `partial` | `boolean` not null default false | the answer ended by abort or timeout (§8) |
| `error` | `text` null | a code, never model or user text |
| `lease_until` | `timestamptz` not null | §8.2 |
| `created_at`, `updated_at`, `finished_at` | `timestamptz` | |

Constraints and indexes:
- `unique (thread_id, turn_id, attempt_key)`: one row per attempt key, re-armed in place.
- `unique (thread_id) where state = 'running'`: **one running attempt per thread** (case 20).
- `index (lease_until) where state = 'running'`: the expiry sweep.
- `index (hold_id) where state = 'running'`: the age pass's `NOT EXISTS` probe (§8.2).
- `check ((state = 'answered') = (answer_id is not null))`.

### 4.2 `agent_threads.billing_org_id` and `agent_threads.revision`

**`agent_threads.billing_org_id`**: `uuid null`. The org the thread's turns bill to (Q1). It is
written once, by the acceptance of the thread's first turn, under the thread lock (`… SET
billing_org_id = $org WHERE id = $thread AND billing_org_id IS NULL`), and never changed. An
existing thread has null until its next accepted turn pins it. For a project thread it is the
project's org (§6.2).

**`agent_threads.revision`**: `integer not null default 1`. Every statement that writes `messages` sets `revision = revision + 1`
in the same `UPDATE`: acceptance (§5, when it appends the turn), finalize (§5), `createThread`'s
rewrite (`agent.ts:80-89`), and ADR 0001's `startConversation` insert (revision 1). `renameThread`
writes no messages and leaves it. `getThread` returns it, together with `inFlight: { turnId,
since } | null` read from the running claim **whose lease is not silent** (`lease_until >= now()`),
so a dead process's claim does not show "Being answered" while it waits for the sweep.

**Nothing but the attempt writes `messages` while an attempt runs.** The one other writer,
`createThread`'s rewrite of a one-message row (`agent.ts:80-89`), takes the thread lock and does
nothing when the thread has a `running` claim (an I test pins it). If a future writer breaks this,
finalize answers `moved` (§5.3), never a silent overwrite.

### 4.3 RLS, and why the key and the visibility agree (case 8)

`agent_turn_claims` gets its own policy in `programmables.sql`, outside the `owner_all` loop:

```sql
CREATE POLICY owner_only ON public.agent_turn_claims FOR ALL
  USING (user_id = current_setting('app.current_owner', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_owner', true)::uuid);
```

- **The key has no org in it, on purpose.** A thread is its user's (`org_id = owner`,
  `agent.ts:97`) and is listed in every org, so its turn is one turn whichever org's tab drives it.
  Two orgs' tabs sending one turn collide on `(thread_id, turn_id, attempt_key)`, and the policy
  shows both of them the row they collide on. That collision is the claim working. The org the turn
  is billed to is a column (`billing_org_id`), not a visibility rule.
- **Ownership is proved by a locked read, not by the foreign key.** Postgres skips row security for
  foreign-key checks, so the FK alone would accept a claim on another user's thread id. Acceptance
  first locks the thread with `SELECT … FOR UPDATE … WHERE id = $thread AND user_id = $actor`
  (§5 step 2). A thread the caller does not own is `thread-not-found`, and nothing is written.
- **Removal.** `deleteThread` deletes the thread row before it writes the tombstone
  (`agent.ts:198-216`), so `ON DELETE CASCADE` removes the thread's claims in the same transaction,
  and so does `listThreads`' reap. Referential actions also bypass row security, so this needs no
  owner-pinned function (ADR 0001's drafts need one only because they have no FK, §3.2 there).
  `deleteThread` itself does not change.
- **Writes.** Acceptance, heartbeat and finalize run on the service-role transaction that
  `assertAiAllowed` already uses (§5), and every statement there names `user_id = $actor.userId`
  explicitly. The policy governs the app-role reads (`getThread`'s `inFlight`). An I test pins both.

## 5. The claim state machine (server)

Every transition is one transaction, and every read and write of it runs on that transaction's
connection (`tx`), the hold's included. Acceptance, finalize and expiry hold the thread row's lock;
finalize and heartbeat are also fenced by `token`.

**One lock order, everywhere:** the org's AI-budget advisory lock, then the thread row, then the
claim row, then the hold's ledger row. A transaction that does not need an earlier lock skips it,
and none takes them out of order:

| Transaction | Org advisory lock | Thread `FOR UPDATE` | Claim | Ledger row |
|---|---|---|---|---|
| Acceptance (§5.1) | 1st | 2nd | 3rd | 4th (reserve; C8's release) |
| Finalize (§5.3) | — | 1st | 2nd | 3rd (settle or release) |
| Expiry by the sweep (§8.2) | — | 1st, `SKIP LOCKED` | 2nd | 3rd (release) |
| Heartbeat (C5) | — | — | only lock | — |

Finalize therefore locks the thread **before** its `UPDATE agent_turn_claims`, so it cannot
deadlock with an acceptance that runs C8 on the same claim (§8.3). The heartbeat holds one row lock
and waits on nothing else, so it cannot close a cycle.

| # | From | Event | Guard | To | Effect |
|---|---|---|---|---|---|
| C1 | none | accept (§5.1) | every check of §5.1 passes | `running` | insert the claim; reserve the hold; append the user turn if it is not stored; `lease_until = now() + 90 s` |
| C2 | `failed` or `expired` | accept for the same key | as C1 | `running` | re-arm in place: new `token`, `attempt_no + 1`, new hold **under the thread's pinned org**, `error := null`. `billing_org_id` and `project_id` are rewritten from the thread, which equal the first attempt's, because the pin never changes (Q1) |
| C3 | `running` | accept for the same key | — | unchanged | refuse `turn-in-progress` |
| C4 | `answered` | accept for the same key | — | unchanged | refuse `turn-answered` |
| C5 | `running` | heartbeat (route, every 30 s) | `token` matches | `running` | `lease_until = now() + 90 s`. A heartbeat that matches nothing reads why: the claim exists under another token or state (C8 ran), and the route aborts the model; or the claim is gone and the thread is a tombstone (deleted), and the route **keeps going** so the answer reaches the Recovered thread (Q4, §8.2) |
| C6 | `running` | finalize with model output | `token` matches and the thread's revision is `accepted_revision` | `answered` | append (or, for a continuation, replace) the answer; `revision + 1`; `answer_id`; `partial`; **settle the hold in the same transaction** (§8.1) |
| C6m | `running` | finalize with model output | `token` matches, the revision moved (§4.2 forbids it) | `failed`, `error = 'transcript-moved'` | nothing stored; the hold is released to 0 in the same transaction |
| C7 | `running` | finalize without model output (error, abort or timeout before the first model part) | `token` matches | `failed` | `error`; the hold is released to 0 in the same transaction |
| C8 | `running` | lease silent: `lease_until < now()` | run first by any accept on the thread (under its lock) and by the `release-ai-holds` sweep | `expired` | the hold is released to 0 in the same transaction, `settled_at` stamped as `releaseStrandedAiHolds` does (`ai-holds.ts:68`); the user turn stays stored and unanswered |
| C9 | any | thread row deleted | — | (row gone) | cascade (§4.3) |

A finalize that matches no row (C6/C7 lost to C8, or the row was cascaded away) is §8's "lost
finalize".

### 5.1 Acceptance: `reserveTurn`

`lib/agent/turn-claims.ts` exports `reserveTurn(input) → Accepted | Refused`. The route calls it
after the body is parsed, `refuseUserMessage` has passed (`route.ts:181`), the billing org is
resolved (§6.1: the thread's pin, or the named org for a first turn) and, for the project route,
the project is checked (§6.2). It is **one** service-role transaction:

1. `pg_advisory_xact_lock(hashtext('ai_budget'), hashtext(orgId))`, the lock `assertAiAllowed`
   already takes (`ai-guard.ts:322`), for the org §6.1 resolved. It is taken first, always (§5's
   lock order).
2. Lock the thread: `SELECT id, user_id, kind, project_id, status, billing_org_id, revision,
   messages FROM agent_threads WHERE id = $thread AND user_id = $actor.userId FOR UPDATE`.
   - No row: when `kind = agent` and the id is free, insert an empty row under it (today's recreate,
     `transcript-save.ts:145-158`); when the id is held by another owner (the insert does nothing),
     refuse `thread-not-found`.
   - A tombstone: refuse `thread-deleted`.
   - `kind` or `project_id` (null-safe) differs from the route's: refuse `thread-not-found`.
   - `billing_org_id` is set and is not the org of step 1: the pin was written by a racing first
     turn after §6.1 read it. Roll back and run §6.1 and `reserveTurn` once more; the pin is
     write-once, so the second run locks the pin it read. Otherwise, if it is null, set it to step
     1's org.
3. Run C8 for this thread's running claim if its lease is silent.
4. Classify the request (§5.2) against the locked transcript, which gives the attempt key, then
   read the claim row of that key: none (C1), `failed`/`expired` (C2), `running` (C3,
   `turn-in-progress`) or `answered` (C4, `turn-answered`). A refusal returns here; the transaction
   rolls back and nothing was written. **This step comes before step 5**, so a duplicate of a
   running turn is `turn-in-progress` (committed), never `thread-busy` (not committed).
5. If another attempt of this thread is `running`: refuse `thread-busy` (case 20).
6. Insert the claim (C1) or re-arm it (C2).
7. Reserve the hold: the body of `assertAiAllowed`'s metered branch, extracted as
   `reserveAiHold(tx, orgId, kind, userId)` and run on **this** transaction (it already runs under
   the lock of step 1). The plan read it needs (`resolveAiPlan`, `lib/billing/ai-plan.ts:165`, which
   reads the billing row through `getOrgBilling` on its own connection today) takes `tx` and runs
   here, after the lock. It keeps today's split: it **decides** inside the transaction and
   returns a refusal decision, the transaction rolls back steps 2-6, and only then is the
   `AiBudgetError` built and thrown, with its reset times read after the lock is released
   (`ai-guard.ts:308-311`). Building it inside would bring back the pool deadlock that comment
   warns against. The route answers 402 as today (`route.ts:205-215`). Without hosted billing it reserves nothing and
   `hold_id` stays null.
8. For an `answer` attempt whose turn is not yet stored, append the user message (§5.2), with
   its mentions and cell target in its `metadata` (§9.2), and add one to `revision`. For a
   `continue:a:<P>` attempt whose outputs are not yet stored, merge the outputs of `P` into the
   stored `a` and add one to `revision`: **an approval is durable from its acceptance**, whatever
   happens to the model call it starts. Set `accepted_revision`.
9. Commit. The route then opens the stream and writes, before anything else,
   `data-turn-accepted { turnId, answerId, revision }`.

C8 at step 3 releases the expired claim's hold with an `UPDATE` on `tx`, not through
`releaseAiHold`, which reaches `recordAiUsage` and a second pooled connection (`getServiceDb()`,
`ai-quota.ts:318-338`). That is the pool deadlock `ai-guard.ts:308-311` warns against, and it would
not be atomic with the claim's `expired`.

**Why one transaction.** Two transactions, a claim and then a hold, leave a moment with a claim and
no hold (a crash there freezes the turn until expiry) or a hold and no claim (the double reserve this
issue exists to stop). Steps 1 and 7 already share one lock and one connection in `assertAiAllowed`;
the claim joins them. The second request for a turn waits on the thread lock and then reads the
first one's committed claim, so it is refused at step 4 or 5 and **never reaches step 7**.

### 5.2 Classifying a request

The request carries `turn: { trigger, turnId, baseRevision, answerId?, toolCallIds? }` (§9.1). Let
`T` be the locked row's `messages`, `last` its last message, and `u` the request's message with id
`turnId`.

**Which rows apply.** A request whose last message is an **assistant** message (a continuation)
is classified by the two continuation rows only. The other rows apply only when a **user**
message is last (a submit or a Retry) or the trigger is `regenerate-message`. Among the submit
rows, the different-text row is checked first.

**Equal text.** "`u`'s text equals the stored text" compares one string per message: the `text`
parts joined in order, after ADR 0001's normalization (its §4.1: `\u0000` removed,
`toWellFormed()`, trimmed at send), plus one rule of this ADR's own, applied on both sides: line
endings to `\n`. No other part type and no `metadata` field takes part. The same function,
`turnText(message)` in `lib/agent/turn-key.ts`, normalizes both sides, so ADR 0001's own D12 first
send (whose stored row was trimmed by `startConversation`) compares equal to what its tab sends. A U
test pins that pair.

| Request | Condition on `T` | Attempt key | Outcome |
|---|---|---|---|
| submit, `u` is the last request message | `turnId` not in `T`, `revision = baseRevision` | `answer` | accept; step 8 appends `u` |
| submit | `turnId` not in `T`, `revision ≠ baseRevision` | — | refuse `transcript-stale` (case 6) |
| submit or Retry (`regenerate` with no `answerId`) | `last` is `turnId`, unanswered, and `u`'s text equals the stored text | `answer` | accept; answer the **stored** message, append nothing |
| the same | `turnId` in `T` (answered, unanswered, or being answered), and the text differs | — | refuse `turn-committed-different-text` (case 19, §9.3), with `answered` as stored. The request's text is **not** committed. Checked **before** the two rows around it and before the claim row (§5.1 step 4), so an edited re-send is never read as `turn-answered` or `turn-in-progress`, both of which consume the draft |
| the same | `turnId` in `T` and answered (any later message exists), the text equal | — | refuse `turn-answered` (case 2) |
| regenerate, `answerId = a` | `last` is `a` and `a` answers `turnId`, `revision = baseRevision` | `regen:a` | accept; finalize replaces `a` |
| the same | otherwise | — | refuse `turn-answered`, carrying the stored answer id (case 11) |
| continuation (submit with the assistant message last, `answerId = a`, `toolCallIds = K`) | `last` is `a`; `P = pendingClientToolCalls(stored a)` (§3) is not empty; `K = P`; the request's `a` carries an output for every id of `P`; and **either** no id of `P` has a stored output and `revision = baseRevision` (the first approval), **or** every id of `P` has a stored output and the claim `continue:a:<P>` exists (a retry of that continuation; its claim row then decides: `failed`/`expired` re-arm, `running` is `turn-in-progress`, `answered` is `turn-answered`) | `continue:a:<P>` | accept; on the first approval, step 8 stores **only** the outputs of `P` from the request. On a retry the stored outputs win and the request's are ignored. Outputs for any other tool call (a server tool's, already stored by finalize) are ignored, never compared |
| the same | otherwise | — | refuse `turn-answered` (the continuation already ran and its answer moved on, or the request does not match `a`) |

Then the claim row of that key decides (§5.1 step 4, before the busy check): none (C1),
`failed`/`expired` (C2), `running` (C3), or `answered` (C4).

**Why the approval is stored at acceptance, and why a stored approval can be retried.** Approve
has already queued its server action (`tryPlanProject` or `tryProvisionProject`, `components/agent/approval-card.tsx:56-57`) when the
continuation request leaves. If the outputs were stored only by finalize, a continuation that ends
before its first model token (Stop, a closed tab, a provider error, a crash) would store nothing,
the card would render unresolved on reload, and a second Approve would queue a second provision.
Dev keeps the output in that case because `onFinish` saves on abort. Storing at acceptance keeps
it. The guard's second arm then lets the failed continuation be retried: the stored outputs and
the existing claim identify it, and C2 re-arms it. A retry is a continuation request again, never
`regenerate()` (§9.1).

**Why the key is derived from the stored answer, from client tools only.** Revision 1 named "the
tool calls of the last step whose outputs are present" on the client, and "with no stored output" on
the server. Those differ whenever a server tool shares the step with the proposal: the client names
both, the server finds `list_projects`'s output stored, and refuses the approval as answered on
every attempt (case 7b). `pendingClientToolCalls` reads only tool names and `providerExecuted`,
which the client's copy and the stored row agree on, never output presence, which they do not.

**The request's transcript is never stored.** The model's input is `T` (after step 8, with any
merged tool outputs), or, for `regen:a`, `T` **without** `a` (the model reads a trailing assistant
message as text to continue, and `originalMessages` ending in `a` would make ai treat the stream as
a continuation of `a`, `index.mjs:6485`). It is never the client's list. It is converted with `convertToModelMessages(…, {
ignoreIncompleteToolCalls: true })`: a partial answer stored after an abort mid-tool (§8.1) can hold
a tool call with no result, and without that option every later turn of the thread would send the
provider a dangling tool call. The client's list contributes `u`'s parts, `u`'s mentions and cell
target (§9.2), and, for a continuation, the outputs of `P`. Everything else in it is ignored.

### 5.3 Finalize

`finalizeTurn(claimId, token, outcome)` is called exactly once per attempt by the route, through an
in-memory once-guard, from whichever of these happens first:

- **The model finished.** The route merges `result.toUIMessageStream({ sendFinish: false,
  generateMessageId })` (`index.mjs:8693`), awaits the model's end, runs finalize, writes
  `data-turn-finished { answerId, revision }`, and only then writes `finish` and closes the
  stream. So the client's `status` cannot reach `ready`, and no auto-send can start, before the
  answer is stored and the claim is `answered` (case 17).
- **The model failed** (`onError`), **the client disconnected**, or **the route's own timeout fired**
  (`onAbort`, §8.2).

One transaction, in §5's lock order: lock the thread (`SELECT … FOR UPDATE`), then `UPDATE
agent_turn_claims SET state = … WHERE id = $claim AND token = $token AND state = 'running'
RETURNING …`, then, for C6, append the answer under `revision = accepted_revision` and add one,
and **settle the hold on the same `tx`**: `recordAgentTurnUsage` takes `tx`, and its row 0 (the
hold, `agent-metering.ts:141`) and its appended rows are written before the commit. C7, C6m and C8
release the hold the same way. A crash or a failed metering write after the answer is stored is
therefore impossible: either the whole transaction commits (stored and settled, `settled_at`
stamped, so `release-ai-holds` never sees the row), or none of it does and the claim stays
`running` until C8 releases the hold. Only the ledger writes run inside: `recordAiUsage`'s side
effects (`captureAiGeneration` and `checkAiSpendThreshold`, `ai-quota.ts:366-400`, the second of
which reads the ledger on a pooled connection) run **after** the commit, so a rolled-back finalize
reports nothing and the spend alert reads the settled ledger. Its outcomes:

| Outcome | Meaning | The answer | The hold |
|---|---|---|---|
| `won` | C6 or C7 applied | stored (C6) or none (C7) | C6: settled in the transaction; C7: released to 0 in it |
| `moved` | C6m applied: the token matches, the revision does not (§4.2 says nothing else writes) | not stored | released to 0 in the transaction |
| `deleted` | no claim row, and the thread is a tombstone | stored in a "Recovered: …" thread, as today (`transcript-save.ts:123-137`), built from `T` + the answer | settled in the same transaction as the Recovered thread's insert (the user has the answer) |
| `lost` | the claim exists under another token or state (C8 ran) | not stored | not touched (C8 released it to 0) |

**A deleted thread does not stop the model (Q4).** The cascade removes the claim, and the
heartbeat (C5) reads "no claim and a tombstone" as `deleted`, not as `lost`, so the route keeps
streaming and the **full** answer reaches the Recovered thread, as it does on dev today. The turn is
still bounded by `TURN_BUDGET_MS` (§8.2), far inside the tombstone's day.

## 6. The billing org (cases 3, 4, 10, 15)

### 6.1 The resolver

**Which org (Q1).** The request names an org: `orgId` in the body. For Elench it is the
server-resolved org id of the page (ADR 0001's `pageOrg`, D29). The route reads the thread's
`billing_org_id` (an unlocked read; §5.1 step 2 re-checks it under the lock):

- **Pinned:** the turn bills to, and runs in, the pinned org. The request's `orgId` is still
  required (its absence is `client-outdated`, §10) but does not choose the org. A Retry,
  regenerate, continuation or new turn sent from org B's tab into a thread pinned to A is A's.
- **Not pinned** (the thread's first accepted turn, or an existing thread's first turn after
  deploy): the request's `orgId`, which acceptance then pins.

Why pin: a thread is its user's and is listed in every org (§1, Threads), so without a pin one
answer's continuation could run its tools and bill in a different org from the answer it continues,
and a C2 re-arm could reserve under B a turn whose first attempt A paid for. With the pin, one turn,
and one thread, has one ledger.

The route resolves the chosen org with one function, `resolveTurnActor(userId, orgId)`, in
`lib/authz/guard.ts`:

1. `orgId === userId`: the personal actor. In community, every page resolves here
   (`lib/auth/scope.ts:20-31`), so the client names the user id.
2. Otherwise `resolveNamedOrgScope(userId, orgId)` (`guard.ts:154-160`), which is strictly two-way:
   the enterprise resolver lands on the named org only for an **active** member
   (`ee/src/scope.ts:75-84`), and any other answer is `null`.
3. `null`, or no `orgId` at all: **403 `org-forbidden`**, before the claim and the hold. There is no
   session fallback and no personal fallback for a named team org. For a pinned thread this is how
   a caller who has left, or been suspended from, the pinned org is refused: the thread still
   lists, and every send into it is `org-forbidden` with the reason "This conversation belongs to
   an organization you are no longer a member of".

It then checks `can(actor, "view", { type: "org" })` without recording activity (the
`authorizeQuiet` shape, `guard.ts:113-122`), because a chat turn is not an activity-log event.

`authorizeInOrg` (`guard.ts:180-199`) is not reused: it records activity through `enforce()`, and it
refuses the personal org in community (its resolver is two-way, `guard.ts:59-64`).

### 6.2 The project check

A project thread's pin is its project's org. The project route then requires `projects.id = projectId AND projects.org_id = actor.orgId` (one
service-role read) **and** `can(actor, "view", { type: "project", id: projectId })`. Either failing
is **404 `project-not-found`**, before the claim and the hold. 404, not 403, as the console's
`[org]` pages answer, so a status code does not confirm that a project id exists elsewhere.

### 6.3 The rest of the turn runs as that actor

From the resolver on, the route runs inside `runWithActor(actor, …)`. `resolveActiveEnvironmentId`
(`resolve.ts:149`), the knowledge builders and every server action a tool calls then resolve the
named org, not the session's. The hold, the metering rows (`orgId: actor.orgId`), the claim's
`billing_org_id` and the data the model read are one org (case 15).

The tools run during the stream, after the route handler has returned the response. They are
reached through promises created inside `execute`, which runs within `runWithActor`, and
`AsyncLocalStorage` follows promise continuations. That is a property of the runtime this ADR relies
on, so an R test pins it: a tool executed in step 2 sees the named org while the session names
another.

A member removed or suspended **during** an accepted turn keeps that turn (it was authorized at
acceptance); the next request is refused by §6.1.

## 7. The transcript: append with a base revision (cases 6, 20)

`saveThreadTranscript` stops being the chat routes' writer. It remains for the recovered-thread
branch only (§5.3 `deleted`). The routes write through §5's two statements:

- **acceptance** appends `u` to `T` (or appends nothing, when `u` is already stored) and adds one to
  `revision`;
- **finalize** appends the answer, replaces answer `a` for `regen:a`, or replaces `a` with its
  continued form for `continue:a:…`, under `WHERE revision = accepted_revision`, and adds one.

`transcript-save.ts`'s `TranscriptRows.updateLive(id, kind, projectId, messages)` is replaced by
`appendLive(id, kind, projectId, baseRevision, messages)` and `replaceLast(…, baseRevision, message)`.
No statement in the chat routes writes a client-supplied list.

**Why refuse a stale base instead of appending anyway.** Appending a stale tab's new turn after
turns it never showed would keep every turn, but the model would answer a question asked against a
conversation the user was not looking at, and the user would see their question answered in a
context they did not see. ADR 0001 already loads the transcript before any send (D9, D9a) and refuses
to send from an unloaded one. `transcript-stale` is the same rule for a transcript that was loaded
and then moved on in another tab. It is refused before the hold, the client loads the transcript,
and the words go back into the box (§9.3).

**Why one running attempt per thread.** Two different new turns at one base both pass the revision
check at acceptance if both arrive before either finishes. The partial unique index (§4.1) and §5.1
step 5 refuse the second as `thread-busy`. `useChat` already allows one request per chat in a tab;
this makes it one per thread across tabs and devices.

**The proxy's 10 MiB body clone** (ADR 0001 §1) is unchanged by this ADR, because the transport still
sends the whole list. Sending only the last message is a safe follow-up once the server ignores the
rest (§10, PR 2).

## 8. Billing, crashes and timeouts

### 8.1 What is billed

**Rule: an attempt is billed if and only if it stores an answer, and it is settled in the
transaction that stores it.** Each attempt has its own hold row, held in the memory of the one
process that reserved it, so no two processes can settle one hold. The `running → answered`
compare-and-set decides who stores, and only the winner (or the `deleted` branch, which also
stores) calls `recordAgentTurnUsage`, on the finalize transaction (§5.3). A `lost` finalize calls
nothing. Because a `recordAgentTurnUsage` call appends rows past row 0
(`agent-metering.ts:113-148`), this is also what stops a second call from billing twice.

**Why inside the transaction.** Revision 1 settled after the commit. A crash, or a failed metering
write (`meteringFailed`, `ai-quota.ts`), between the two left a stored answer with an unsettled
hold, which `release-ai-holds` then released to **0** an hour later: a stored answer billed nothing.
Settling on the same `tx` removes the gap; the cost is that a metering write error now fails the
finalize, which then stores nothing and leaves the claim to C8 (the answer the client saw is not
kept, the §8.3 residual), rather than storing an answer it cannot bill. A **persistent** metering
error therefore drops every answer, in every org, until it is fixed, so PR 1 adds an alert on the
`finalize-metering-failed` log event (one occurrence pages), next to the existing
`meteringFailed` log.

| How the attempt ends | Transcript | Claim | Billed |
|---|---|---|---|
| Refused before acceptance (400, 403, 404, 409, 410, 413) | unchanged | none, or unchanged | nothing; no hold |
| 402 budget | unchanged (the transaction rolled back) | none | nothing; no hold |
| Model finished | turn + answer | `answered` | the steps' real cost, as today |
| Provider error before any model output | turn, no answer | `failed` | released to 0, as today |
| Provider error after model output | turn + partial answer | `answered`, `partial` | completed steps; at least the reserve (Q8) |
| Client disconnect or Stop before any model output | turn, no answer | `failed` | released to 0 |
| **Client disconnect or Stop after model output** (case 14) | turn + partial answer (the UI stream's `onFinish` still runs on abort) | `answered`, `partial` | completed steps' real cost, and **at least the reserve** (Q8). Today: 0 |
| The route's own timeout | as the row above | as above | as above |
| Process crash or redeploy | turn, no answer | `running` until the lease is silent 90 s, then `expired` (C8) by the next accept on the thread or by `release-ai-holds` | released to 0 by C8 (Q9), within 90 s of the last heartbeat plus one sweep interval (at most about 17.5 minutes: `release-ai-holds` is gated by `isDue` on the loop's 60 s tick, `loop.ts:33`, so its runs can be up to about 16 minutes apart). Today: released to 0 by `release-ai-holds` after 60 to 75 minutes (§1) |
| Finalize fails (database unreachable) after the model finished | the client saw the answer; the row did not store it | `running`, then `expired` | released to 0 by C8; the residual case of §8.3 |

**Why "at least the reserve" for a partial answer.** `onAbort` reports only completed steps
(`index.mjs:7652`). A one-step answer aborted at its last token has zero completed steps, so the
real-cost rule alone bills it 0 while the user read the whole answer (case 14). The in-flight step's
tokens are not observable, so the floor is the reserve the hold already took. It is an
under-charge for a long answer and an over-charge only for an answer aborted after its first few
tokens. **It needs code:** `recordAgentTurnUsage` today releases the hold to 0 when no step
completed (`agent-metering.ts:100-110`). PR 1 gives it a `floorCredits` input, which finalize
passes as `METERED_RESERVE_CREDITS` when `partial` is true, and row 0 is settled to the larger of
the floor and the real cost (§10 item 3).

### 8.2 The bound and the lease (case 9)

- **The bound.** `streamText` takes `abortSignal: AbortSignal.any([req.signal,
  AbortSignal.timeout(TURN_BUDGET_MS)])`. A timeout fires `onAbort`, so it ends exactly like a
  disconnect (§8.1). Recommended `TURN_BUDGET_MS = 900_000` (Q7): above the six minutes measured
  for a deep-reasoning turn. The `maxDuration` exports are deleted, so nothing claims a bound it does
  not have.
- **The lease measures silence**, as ADR 0001's draft lease does (its R0). The route renews it every
  30 s (C5) while the attempt runs, and `lease_until = now() + 90 s` at each renewal. A live route
  therefore never loses its claim to the lease unless the database is unreachable for 90 s, and then
  its finalize would fail anyway. A dead process stops renewing. The next accept on the thread
  expires it (C8) as soon as it is 90 s silent; otherwise the sweep does, on its next run after
  that, so within 90 s plus one sweep gap (about 16 minutes, the 15-minute interval on a 60 s
  tick) of the last renewal: about 17.5 minutes at worst.
- **A heartbeat that matches nothing** because the claim expired (it exists under another token or
  state) aborts the model, so the route stops paying for an answer it can no longer store. One that
  matches nothing because the thread was deleted keeps going (§5.3, Q4).
- **One sweep owns stranded holds (Q5): `release-ai-holds`, extended.** There is no second
  sweep. The existing task (`lib/reconcile/ai-holds.ts`, every 15 minutes, `loop.ts:49`) runs three
  passes, each batched as today:
  1. **Expire silent claims (C8).** Every `running` claim with `lease_until < now()`, locked in
     §5's order (thread `FOR UPDATE SKIP LOCKED`, then claim, then ledger row), is set `expired` and
     its hold released to 0 in one transaction per claim.
  2. **Release unclaimed stranded holds,** as today: `settled_at IS NULL` and older than the window
     below, **excluding** any hold that a `running` claim names (`NOT EXISTS (SELECT 1 FROM
     agent_turn_claims WHERE hold_id = l.id AND state = 'running')`). A claimed hold is released
     only by its claim's lease, never by age.
  3. **Retention:** delete terminal claims older than 30 days whose thread still exists (Q10).
- **The window, re-derived.** `ai-holds.ts:27-37` derives 60 minutes from "the platform's function
  timeout". That timeout does not exist: the console runs as a standalone Node server, and the
  `maxDuration = 300` exports bound nothing (§1, Duration). The real bounds are these:
  - a chat-route hold after PR 1 is claimed, so pass 2 never reads it; its turn is bounded by
    `TURN_BUDGET_MS` (15 minutes), and its release by C8;
  - every other hold (the support and agent-identity routes until Q11, the `colony` and
    `verify` actions, and a turn that ran on the old process across the deploy) has **no** time
    bound at all. For those, 60 minutes is an assumption, not a derivation.

  60 minutes is kept. It is longer than `TURN_BUDGET_MS` + the 90 s lease + one sweep interval
  (about 32 minutes), so pass 2 could not release a live chat hold even without its exclusion. For
  an unbounded caller that runs past it, an early release costs headroom accuracy only, not money:
  the late settle overwrites the row in place (`ai-quota.ts:318-338`) and the turn is billed once.
  PR 1 rewrites the comment at `ai-holds.ts:27-37` to say exactly this, and drops its false "books
  the cost twice".
- **`agent.ts:119-123` is corrected** to cite `TURN_BUDGET_MS` plus the 90 s lease: a turn streaming
  at the delete finalizes within about 16 minutes, far inside the tombstone's day.

### 8.3 Residual: a live route that lost its lease

If the database is unreachable for more than 90 s while a route is still streaming, C8 can expire the
claim, a Retry can re-arm it (C2), and two answers can stream. The first route's finalize is then
`lost`: its answer is not stored and not billed, and its tab, which never received
`data-turn-finished`, is refused `transcript-stale` on its next send and loads the stored transcript.
The user saw one answer that was not kept. It is billed once (the stored one). An R test pins it.

## 9. The client

### 9.1 The request

The transport (`use-agent-chat.ts:61-63`) passes what ai 6 gives it and adds the turn:

```ts
prepareSendMessagesRequest: ({ messages, trigger, messageId }) => ({
  body: { messages, orgId: orgRef.current,
          turn: turnOf(messages, trigger, messageId, revisionRef.current),
          ...prepareBody?.(messages) },
}),
```

`turnOf` reads: `trigger`; `turnId`, the last **user** message's id; `answerId`, the `messageId` of
a regenerate or the last assistant message's id for a continuation; for a continuation,
`toolCallIds = pendingClientToolCalls(that message)` (§3), the **same function** the server runs
over the stored answer, which reads tool names and never output presence; and `baseRevision`.

- `revisionRef` is set by `loadInto` from `getThread().revision`, by every `data-turn-accepted` and
  `data-turn-finished` part, and by the revision that ADR 0001's `startConversation` `created`
  outcome and `createThread` return for the thread row (both return it; revision 1 left a new
  empty row unseeded, so its first turn was `transcript-stale` once).
- `orgRef` is read at request time, as `revisionRef` is. `useChat` keeps a Chat's first transport
  for the Chat's life (it is recreated only when `id` changes), so a closed-over `orgId` would be
  the first render's. AppShell remounts under the `[org]` layout today, so this is not reachable
  yet; the ref keeps a later shell change from turning it back into case 3.

- **Regenerate passes the answer it replaces.** `regenerate()` slices that answer off before the
  transport runs, so both call sites change to `regenerate({ messageId: answer.id })`
  (`elench-conversation.tsx:464`, `agent-chat.tsx:376`). A tab can therefore only regenerate the
  answer it displays (case 11).
- **The error card's Retry** (`elench-conversation.tsx:302`) is chosen by what is last:
  - a **user** message (an unanswered turn): `regenerate()` with no `answerId`, an `answer`
    attempt (§5.2);
  - an **assistant** message whose pending client tool calls all have outputs (a failed
    continuation): the continuation request again (trigger `submit-message`, the assistant message
    last, as `addToolOutput`'s auto-send makes it), which §5.2's retry arm re-arms;
  - any other **assistant** message (a partial answer after a provider error):
    `regenerate({ messageId })`, a `regen:a` attempt. Revision 2's plain `regenerate()` sliced the
    answer off and was refused `turn-answered`, so Retry became a silent reload.
- **The continuation needs no new client id.** Its key is derived from the stored answer and its
  pending client tool calls, so two tabs that approve the same card make the same key and one of
  them is refused (case 7), and a server read tool in the same step does not enter the key (case
  7b).

### 9.2 Mentions and the cell target move to the message (case 13)

The routes read the mentions and the cell target of the turn's **stored** user message (§5.2),
validated with `mentionsSchema` and the existing cell schema. Where each comes from depends on what
the sends carry, and revision 1 overstated that:

| Field | ADR 0001 rev 5.1 writes it into `metadata` on | PR 1 reads | Deleted from the body by |
|---|---|---|---|
| `mentions` | the first turn (`startConversation`, its §5.1 step 3) and every later turn (D9b: `sendMessage({ id, parts, metadata: { mentions } })`) | `metadata.mentions`, else `body.mentions` | this ADR's PR 2, after ADR 0001's PR 2 (which ships D9b) |
| `cellTarget` | the first turn, an external start (D10x) and the failed-send marker **only**. A later turn's D9b sends no `cellTarget` | `metadata.cellTarget`, else `body.cellTarget` | this ADR's PR 2, and only once ADR 0001's D9b also sends `metadata.cellTarget` (§9.4, change 3) |

The empty-cell prompt sends into the **current** conversation, usually an existing thread with
widgets (`elench-conversation.tsx:316-324`), so it is a later turn. Until D9b carries the target,
`body.cellTarget` (from `takePendingCellTarget()`, `:172`) is the only path for it, and deleting it
would land the widget by first-fit instead of in the cell the user clicked: the (0,0) regression
recorded at `:170-172`. The fallback is read for the **acceptance's** user message only, and §5.1
step 8 writes it into that message's `metadata` as it appends, so the stored turn carries its
target from then on (a Retry of it needs no body). A stored message's metadata always wins. Tests: R › `a later-turn cell prompt with body.cellTarget and no
metadata lands in the named cell`; C › `a later-turn cell prompt stores its cell target in the user
message's metadata` (PR 2, after ADR 0001's D9b change).

### 9.3 Refusals (case 12)

Every refusal before acceptance is a JSON body:

```ts
type TurnRefusal = {
  refusal: "turn-in-progress" | "turn-answered" | "turn-committed-different-text"
         | "thread-busy" | "transcript-stale" | "thread-deleted" | "thread-not-found"
         | "org-forbidden" | "project-not-found" | "client-outdated";
  turnId: string | null;
  committed: boolean;      // a turn with this id is in the stored transcript
  textCommitted: boolean;  // ...and its text is the text this request sent
  answered: boolean;       // ...and it has an answer
  revision: number | null;
  answerId: string | null;
};
```

Statuses: 409 for the first five and `client-outdated`, 410 `thread-deleted`, 404
`thread-not-found` and `project-not-found`, 403 `org-forbidden`. **This is ADR 0001 §5.3's second
item**: a refused send says whether its turn is committed and whether it is answered, and now also
whether **the text it sent** is the committed one. `textCommitted` is false only on
`turn-committed-different-text`; on every other refusal it equals `committed`.

How the client reads it:

| Refusal | `committed` | Client |
|---|---|---|
| `turn-in-progress` | true | ADR 0001 D9d's "committed" arm: `consumeDraft`, then D20: load the transcript, show "Being answered in another tab or device", poll `getThread` until `inFlight` is null |
| `turn-answered` | true | `consumeDraft`, then D20: load the transcript. No error card |
| `turn-committed-different-text` | true, `textCommitted: false` | **Not** consumed (Q3). ADR 0001 releases the draft with the edited text and a **fresh** turn id (§9.4, change 1), then loads the transcript. The stored turn shows "No reply arrived" with Retry; the box keeps the edit, and the card reads "An earlier version of this message was already sent. It is shown above. Your edit is still in the box." Enter sends the edit as a new turn |
| `thread-busy` | false | load the transcript; the words go back into the box; "Another message in this conversation is being answered" |
| `transcript-stale` | false | load the transcript; the words go back into the box; "This conversation has newer messages. They are shown now. Press Enter to send." (ADR 0001 D9a's wording) |
| `thread-deleted` | false | ADR 0001 D18: the words move to a new conversation |
| `org-forbidden`, `project-not-found`, `thread-not-found` | false | the words go back into the box with the reason |
| `client-outdated` | false | "Reload to continue"; the words stay in the box |

For ADR 0001, every `committed: false` refusal is a refusal "the route itself answers before its
budget hold, which stores nothing", which is the principle of its D9d's certain release (§9.4,
change 2).

**Why the edited re-send is not consumed.** Revision 1 sent it as `committed: true`, and ADR 0001's
D9d consumes the draft on any committed refusal. The sequence that reaches it is ordinary: a later
turn X waits on the org or thread lock, D9d's 60 s deadline fires and releases X `uncertain` before
the acceptance commits, the acceptance then stores X with no answer, and the user corrects the box
to X' and presses Enter. D31 and R10 send X' under X's turn id, the route refuses, and consuming the
draft would delete X' while only X is stored. That breaks ADR 0001's founding invariant, "typed text
is never lost". So the refusal says the text is not committed, and ADR 0001 keeps it.

**The client half without ADR 0001's store (PR 1).** `useAgentChat` gets a `fetch` wrapper that
reads the typed body and throws a `TurnRefusedError`. Elench and any surface without ADR 0001's
store (the support chat, if it adopts this, §12) handle it in one function, `onTurnRefused`:
`loadInto` the thread (which refreshes `revisionRef`), `clearError()`, and, on every refusal whose
`textCommitted` is false, put the refused text back into the composer through its existing
`restore` handle (`elench-conversation.tsx:289-292`) with the table's notice. A refused **cell
prompt** also restores its cell target, which `takePendingCellTarget()` consumed when the body was
built (`:172`): `onTurnRefused` re-stages it with `setPendingCellTarget`, so the next Enter lands
the widget in the cell the user clicked. On `turn-in-progress`, the loaded transcript ends on a
user turn, so it shows "Being answered in another tab or device" instead of the `unanswered` rule's
"No reply arrived" (`:223-229`), and polls `getThread` every 5 s until `inFlight` is null, then
loads again. No error card is shown, and a Retry is never needed to recover, because the reload
already refreshed the base revision.

**Exactly one handler.** `onTurnRefused` checks for ADR 0001's store **at run time**: when the store
owns the send (it holds a `sending` entry for this turn id), it dispatches the refusal to the store
(D9d, D20) and does nothing else. The composer path runs only when no store owns the send. So if
ADR 0001's PR 2 lands first, one refusal never reaches both D9d's release and `restore`, whose
merge (D11r) would show the text twice. PR 2 deletes the composer path.

### 9.4 What this ADR needs ADR 0001 to change

ADR 0001 rev 5.1 cannot carry this ADR's refusals as written. Four changes, each with its test,
belong in its next revision:

1. **An edited re-send releases with a fresh turn id; it is never consumed** (Q3). D9d gains an arm
   for `turn-committed-different-text`: `releaseClaim(token, error, { freshTurnId })`, with the
   new id minted by the client. S4's guard today turns any release whose turn is in the transcript
   into S3 (consumed). With `freshTurnId`, S4 applies anyway: content kept, claim cleared,
   `failed_send := { turnId: freshTurnId, …, uncertain: false }`. The same rule applies to S5 (the
   lease settle) and to S4's redirect: a later turn whose id is in the transcript is consumed only
   when the stored message's `turnText` equals the claimed content; otherwise it is released with a
   fresh turn id. R10 is amended: a corrected re-send carries the same turn id **until** the route
   answers `turn-committed-different-text`, and from then on the edit is a new turn. "Never
   re-minted for a stored turn" still holds: the fresh id names the edit, which is not stored.
   Test (ADR 0001's S): `an uncertain later turn stored by a late acceptance, edited and re-sent:
   turn-committed-different-text keeps the edit in the box under a new turn id, and Enter sends it
   as a new turn`; A: `the lease settle releases, not consumes, a claim whose stored turn has
   different text`.
2. **D9d's certain-release list** (400, 402, 413, 429) gains this ADR's `committed: false`
   refusals: 409 `thread-busy`, `transcript-stale` and `client-outdated`, 410, 404 and 403. Without
   it they release `uncertain: true` and D31 says "may already have been sent", which is false.
3. **D9b sends the cell target**: `sendMessage({ id: turnId, parts, metadata: { mentions,
   cellTarget } })`, `cellTarget` taken from the pending slot, so the body fallback of §9.2 can go.
   Test (C): `a later-turn cell prompt stores its cell target in the user message's metadata`.
4. **`startConversation`'s `created` returns the thread's revision**, not only the draft's, so the
   transport's `revisionRef` is seeded (§9.1).

**The dependency.** Change 1 has a server half (S4's `freshTurnId` arm and the S5 text check, in
ADR 0001's server actions) and a client half (D9d's arm and R10). Change 2 is client only.
- **This ADR's PR 1 does not merge until all of change 1 and change 2 are on dev**, whichever ADR
  0001 PR carries them. Gating on D9d alone is not enough: a tab that re-sends an edit under the
  old turn id and dies before the refusal arrives leaves its draft to the S5 lease, which would
  otherwise find the old id in the transcript and consume the edit.
- If ADR 0001's PR 2 is still open when this ADR's PR 1 is ready, the server half of change 1 is
  a small PR against ADR 0001's PR 1 code (`app/server/actions/elench-drafts.ts`), and the client
  half rides in ADR 0001's PR 2.
- Change 3 binds this ADR's PR 2 (which deletes `body.cellTarget`).
- Change 4 binds **whichever PR lands second** of ADR 0001's PR 2 and this ADR's PR 1: the second
  one wires `startConversation`'s returned thread revision into `revisionRef`.

## 10. Migration and rollout (via the db pipeline)

Two PRs. PR 1 holds `mutex:migration` (`.claude/skills/db-pipeline/SKILL.md`).

**PR 1: the server, and the transport fields the server requires.**
1. Rebase onto `origin/dev`. Add `agentTurnClaims`, `agentThreads.revision` and
   `agentThreads.billingOrgId` to `lib/db/schema/agent.ts`. Generate in one worktree (`pnpm -F console db:generate`, which runs
   `scripts/db-generate.sh` under its lock), then `pnpm -F console check:migrations`. The column
   default backfills every row with revision 1.
2. `programmables.sql`: the `owner_only` policy of §4.3, idempotent (`DROP POLICY IF EXISTS`).
3. `lib/agent/turn-claims.ts`: `reserveTurn`, `heartbeatTurn`, `finalizeTurn`, `expireSilentTurns`.
   `lib/agent/turn-key.ts`: `pendingClientToolCalls` and `turnText`, imported by the routes and
   the transport. `lib/ai/client-tools.ts`: `CLIENT_TOOL_NAMES`, with a U test that it equals the
   set of tools in both routes' tool sets that have no `execute`.
   `lib/billing/ai-guard.ts`: extract `reserveAiHold(tx, …)`; `assertAiAllowed` keeps its signature
   for its other callers and calls it. `resolveAiPlan`/`getOrgBilling` and `recordAgentTurnUsage`
   take an optional `tx` (§5.1 step 7, §5.3); `recordAgentTurnUsage` also takes `floorCredits`
   (§8.1) and leaves `recordAiUsage`'s side effects to run after the commit.
4. `lib/authz/guard.ts`: `resolveTurnActor` (§6.1).
5. Both routes: `orgId` and `turn` required, the project check (§6.2), `runWithActor`, `reserveTurn`,
   the stream built from the stored transcript, finalize before `finish`, the heartbeat, the
   timeout, typed refusals. `maxDuration` removed. `lib/agent/transcript-save.ts` and
   `thread-transcript.ts`: `appendLive` / `replaceLast`; the recover branch kept.
6. `app/server/actions/agent.ts`: `getThread` returns `revision` and `inFlight`; `createThread`'s
   rewrite bumps `revision` and does nothing while a claim runs (§4.2); `createThread` returns the
   revision; the `:119-123` comment. **#5464's PR 1 also edits this file**
   (`deleteThread`'s draft purge). Whichever lands second rebases; neither changes the other's lines.
7. The client fields of §9.1 in `use-agent-chat.ts` and `elench-conversation.tsx`, and the two
   `regenerate({ messageId })` call sites. They ship with the server because the server refuses a
   request without them.
8. **The minimum client recovery (Q2):** the `TurnRefusedError` wrapper and `onTurnRefused` of
   §9.3: on every typed refusal, load the transcript (which refreshes `revisionRef`), clear the
   error, and put uncommitted text back into the composer. Without it, PR 1's `transcript-stale`
   would be a dead end between the PRs: Retry re-sends the same stale revision and gets the same
   409, and a reload loses the words, which on dev would at least have been sent. It reuses
   `loadInto` and the composer's `restore`, so it is small. C tests: `transcript-stale reloads the
   transcript, restores the text, shows no error card, and the next Enter is accepted`;
   `turn-committed-different-text keeps the edit in the composer`.
9. `release-ai-holds` extended (§8.2, Q5): the C8 pass, the claimed-hold exclusion, retention, and
   the corrected comment at `ai-holds.ts:27-37`. No new task.
10. An `alethia-security-review` pass: seam 2 (the routes' org and project gates), seam 3 (the new
   policy, the service-role statements and their explicit owner predicates), and billing.

**PR 2: the client half on ADR 0001's store.** Needs ADR 0001's PR 2 and §9.4's changes 1-3.
`onTurnRefused` dispatches to the store (D9d's new arms, D20) and its composer path is deleted; the
"Being answered" state; `body.mentions`, `body.cellTarget` and the `pendingMentions` slot deleted,
and the routes read metadata only; optionally the transport sends only the last message.

**Rollout.**
- **Open tabs on the old bundle.** After PR 1 deploys, a tab loaded before it sends no `orgId` and no
  `turn`. The route answers 409 `client-outdated` before the hold, and the old bundle shows it as an
  error card with the text "Reload to continue". Nothing is billed under a guessed org. (Today's
  bundle cannot read the typed body; its error card shows the response text.)
- **Order against ADR 0001.** PR 1 needs the page's org id on the client. ADR 0001's PR 2 provides
  `pageOrg`. If this PR lands first, it adds the one field itself: the `[org]` layout already
  resolves the org's id on the server and passes it into the Elench store. PR 1 does not need ADR
  0001's PR 2 otherwise (it carries its own recovery, item 8), but §9.4's dependency rule decides
  which of the two waits for D9d's new arms.
- **No data migration.** Existing threads start at revision 1, unpinned, with no claims.
- **The deploy window has two shapes, and neither is clean.**
  - The helm chart's console `Deployment` (`deploy/helm/alethia/templates/console.yaml`) declares no
    strategy, so Kubernetes' default RollingUpdate runs the old and the new pod side by side. A turn
    on the old pod holds no claim and saves wholesale when it ends, which can overwrite turns the
    new pod appended meanwhile, and its tab's "Reload to continue" (on the new bundle) may show
    "No reply arrived" for a turn still being answered; a Retry there is a second answer and a
    second hold. Its hold is unclaimed, so `release-ai-holds`' age pass covers it if it strands.
  - Production's compose deploy (`.github/workflows/deploy-console.yml:1316`) replaces the
    container and kills every in-flight turn. Their holds are unclaimed and are released by the age
    pass after 60 to 75 minutes; their user turns, saved only at the end on dev, are lost.

  Both are bounded to the turns in flight during one deploy, and both disappear once the old
  process is gone.

## 11. Cases, mechanisms and tests

**Test files** (every test must fail on dev @ f586e91e5 on its assertion, not at import):
- **R**: `apps/console/tests/api/agent-turn-routes.test.ts`. Both routes, with ai's mock language
  model and `reserveTurn` over an in-memory fake with real lock and compare-and-set semantics.
- **O**: `apps/console/tests/api/agent-turn-org.test.ts`. The resolver and the project check, with a
  community resolver and an enterprise-shaped one (`ee/src/scope.ts`'s fallback).
- **U**: `apps/console/tests/lib/agent/turn-claims.test.ts`. The classification table (§5.2) and the
  transitions as a pure function.
- **I**: `apps/console/tests/integration/agent-turn-claims.test.ts` (`describeIfDb`). Constraints,
  RLS, cascade, the lock order, the hold in one transaction.
- **T**: `apps/console/tests/lib/agent/transcript-save.test.ts` (existing, extended).
- **C**: `apps/console/tests/components/agent-turn-refusal.test.tsx`. The transport and the client
  half.

Only R and O fall inside #5515's `scope:` globs; Q6 asks to widen it.

| # | Case | Mechanism | Test |
|---|---|---|---|
| 1 | Lost `startThread` response, Retry bills twice | The first turn is stored by `startConversation` (ADR 0001); a Retry is an `answer` attempt on a stored, unanswered turn (§5.2); two Retries share one key | R › `two Retries of a stored first turn: one model call, one hold, the second answers turn-in-progress` |
| 2 | Duplicated tab retries an answered turn | C4 `turn-answered`; nothing written | R › `tab B retries a turn tab A answered: 409 turn-answered, no hold row, A's answer still stored` |
| 3 | Session org bills the turn | §6.1: the body names the org of a first turn, the thread's pin every later one; no session fallback | O › `session on B, request names A: the hold, the ledger rows and the claim are A's`; R › `a turn pinned to A, retried from org B's tab: the re-armed hold, the claim and the tools are A's` (C2, Q1); O › `a caller who left the pinned org: 403 org-forbidden before the hold` |
| 4 | Project not checked before the hold | §6.2, before `reserveTurn` | O › `a project of org B named under org A: 404 project-not-found and no hold row` |
| 5 | Two attempts reach the model | The thread lock + C3 | I › `two concurrent accepts of one turn: one running claim, one hold row, one turn-in-progress` |
| 6 | A stale tab's new turn replaces newer turns | §5.2 `transcript-stale`; §7 append under `revision` | R › `a new turn at an old baseRevision: 409 transcript-stale, no hold, the stored transcript unchanged`; T › `appendLive never writes a client list` |
| 7 | HITL continuation | `continue:a:<P>` (§3, §5.2); finalize before `finish` (§5.3) | R › `approve a plan card: the continuation is accepted after an answered turn and its outputs are merged`; R › `the same card approved in two tabs: one continuation, one turn-answered`; R › `a continuation aborted before its first token: the approval output stays stored, the card is resolved after a reload, and a retry of the continuation re-arms continue:a:<P>`; C › `Retry on a failed continuation resends the continuation, not regenerate()` |
| 7b | HITL continuation from a mixed step | `pendingClientToolCalls` reads names, not output presence, on both sides (§3, §9.1) | R › `a last step with list_projects (output stored) and propose_operation: the approval is accepted under continue:a:<proposal id>, the proposal's output is merged, and list_projects's stored output is unchanged`; U › `turnOf over the client copy and the classifier over the stored answer derive the same key for a mixed step`; U › `CLIENT_TOOL_NAMES equals the routes' tools without execute` |
| 8 | Claim key vs RLS | §4.3: user-only policy over an org-free key; FK cascade | I › `one turn driven from org A and org B: the second accept sees the first claim and refuses`; I › `deleteThread removes the thread's claims`; I › `a claim on another user's thread id is refused although the FK would accept it` |
| 9 | `maxDuration` is not a bound | §8.2: in-route timeout, 30 s heartbeat, 90 s silence | R › `a turn running past 90 s with heartbeats keeps its claim; a Retry answers turn-in-progress`; R › `TURN_BUDGET_MS fires onAbort and finalizes partial` |
| 10 | Named-org resolver | `resolveTurnActor` (§6.1) | O › `enterprise: a suspended member naming their former org is 403 before the hold, not billed to their personal org`; O › `community: orgId = userId resolves` |
| 11 | Regenerate re-bills; stale tab | `regen:a` requires `a` to be the stored last answer (§5.2, §9.1) | R › `regenerate of a displayed answer is billed once`; R › `regenerate from a tab that never saw the newer answer: turn-answered` |
| 12 | The client half of a refusal | §9.3; PR 1's `onTurnRefused` (§10 item 8) | C › `turn-answered loads the transcript and shows no error card`; C › `transcript-stale reloads the transcript, restores the text, shows no error card, and the next Enter is accepted`; C › `turn-in-progress shows Being answered and reloads when inFlight clears` (PR 2) |
| 13 | Mentions, `trigger`, `messageId` | §9.1, §9.2 | C › `the request carries trigger, turnId, answerId, toolCallIds and baseRevision`; R › `mentions are read from the stored user message's metadata`; R › `a later-turn cell prompt with body.cellTarget and no metadata lands in the named cell` |
| 14 | Stream then disconnect, billed 0 | §8.1: `partial` answer billed, floor the reserve | R › `abort after model output: answered partial, hold settled to at least the reserve`; C › `Retry after a partial answer is regenerate({ messageId })` |
| 15 | Nested `currentActor()` | `runWithActor` (§6.3) | R › `a tool executed in step 2 resolves the named org while the session names another` |
| 16 | Crash: the hold sits at the reserve for an hour | C8 releases to 0 at the next accept, or at the next `release-ai-holds` run (§8.2) | I › `a silent running claim is expired by the next accept and its hold is 0`; I › `release-ai-holds expires a silent claim and releases its hold`; I › `release-ai-holds' age pass skips a hold a running claim names` |
| 17 | Auto-send before the save | Finalize before `finish` (§5.3) | R › `no finish chunk is written before the claim is answered` |
| 18 | Thread deleted mid-turn | Cascade; the heartbeat keeps going on a tombstone; finalize `deleted` recovers (§5.3, Q4) | R › `delete during a turn: the model is not aborted, the full answer lands in a Recovered thread and is billed once` |
| 19 | Re-send of a stored turn with edited text | `turn-committed-different-text` (§5.2), never consumed (§9.3, §9.4 change 1) | R › `stored unanswered turn, re-sent with different text: 409 turn-committed-different-text, textCommitted false, no hold`; R › `an answered turn re-sent with different text is turn-committed-different-text, not turn-answered`; U › `turnText of a D12 first send equals the trimmed stored text`; C › `turn-committed-different-text keeps the edit in the composer` |
| 20 | Two different new turns at one base | `thread-busy` (§4.1, §5.1 step 5) | I › `two new turns at one base: one running, one thread-busy` |
| 21 | Old bundle | 409 `client-outdated` before the hold (§10) | R › `a request without orgId or turn: 409 client-outdated, no hold` |

**The transitions, each with its test** (the rows above cite most of them):

| Transition | Test |
|---|---|
| C2 re-arm after `failed` | U › `a failed answer attempt is re-armed with attempt_no 2 and a new token` |
| C5 heartbeat that matches nothing | R › `a heartbeat after expiry aborts the model` |
| C6 lost to C8 | R › `a finalize after expiry stores nothing and does not meter` |
| C6 settles in its transaction | I › `a metering write that fails inside finalize rolls back the answer; the claim stays running and C8 releases the hold` and I › `a committed answered claim has a settled hold row` |
| C6m | I › `createThread's rewrite does nothing while a claim runs`; R › `a finalize whose revision moved is moved: nothing stored, hold 0` |
| C7 | R › `a provider error before output: failed, hold 0, turn stored unanswered` |
| 402 inside acceptance | I › `a budget refusal rolls back the claim and the appended turn` |
| Self-host | R › `without hosted billing a claim is taken and no hold is reserved` |
| Lock order | I › `accepts for one thread from orgs A and B do not deadlock`; I › `an acceptance running C8 on a claim whose route is finalizing does not deadlock`; I › `reserveTurn opens one connection` |
| Continuation rows only when an assistant message is last | U › `a continuation is never classified by the submit rows` |
| `regen:a` model input | R › `a regenerate sends the model T without a` |
| One refusal handler | C › `with ADR 0001's store owning the send, onTurnRefused dispatches to the store and does not restore the composer` |
| C3 before `thread-busy` | U › `a duplicate of a running turn is turn-in-progress, not thread-busy` |
| `getThread` | I › `getThread returns revision and inFlight, and no inFlight for a silent claim` |

**Count.** 21 cases: the 13 of #5515 (1-12 and the addendum) and 8 found while reading the code
(14-21), plus 7b from the review of revision 1. Each has a mechanism and at least one named test.
Five wrong-code facts are corrected on the way: the `maxDuration` exports (deleted, §8.2), the
`agent.ts:119-123` comment (§8.2), the `ai-holds.ts:27-37` comment's "platform's function timeout"
and its "books the cost twice" (§1, §8.2), and `currentActor()`'s missing named-org arm (not added
to it; the routes use `resolveTurnActor`, §6.1). Revision 1 itself stated one wrong fact, that
nothing releases a crashed turn's hold; §1 now describes `release-ai-holds`.

## 12. Out of scope

- **`/api/support/ask` and `/api/agent/[agentId]`** have the same four facts (§1) and are outside
  #5515's `scope:`. `[agentId]` has no console caller at `f586e91e5`. Q11 asks whether PR 1 should
  move them onto `reserveTurn` too.
- **A disconnect that does not cancel.** A closed tab aborts the model today, and this ADR keeps
  that, because a disconnect and Stop look the same to the route. Running on after a disconnect,
  with a separate cancel endpoint for Stop, would let a reload pick up the full answer. It is a
  product change and is not proposed here.
- **Two tabs approving one deploy card.** This ADR makes the continuation run once. Whether the
  approval's own server action (the plan or deploy it queues) runs once is that action's question.
- `components/project-assistant/use-project-assistant.ts` has no caller and sends no `threadId`;
  it is deleted in PR 1 rather than adapted.

## 13. Recommendations for the maintainer to accept or reject

The design above follows every recommendation. Rejecting one changes the sections named in it.

1. **Pin the billing org on the thread at its first turn** (§4.2, §6.1, C2). Continuations, Retries,
   regenerates and later turns bill to, and run their tools in, that org whichever tab sends them,
   and are refused `org-forbidden` if the caller is no longer an active member. Two consequences
   come with it: a thread pinned to an org with no AI plan or a spent budget is 402 from **every**
   tab, including tabs of orgs that have budget; and a thread pinned to A driven from B's page runs
   A's tools and shows A's data in B's grid. *Alternative:* bill
   each request to the org its tab names; then one answer and its continuation can land in two
   ledgers, and a re-arm can bill B for A's turn.
2. **Put the minimum stale-transcript recovery into PR 1** (§9.3, §10 item 8): on every typed
   refusal, load the transcript (refreshing `revisionRef`), clear the error, and put uncommitted
   text back in the composer. It is small because it reuses `loadInto` and the composer's
   `restore`. *Alternative:* make ADR 0001's PR 2 a hard prerequisite of PR 1; then PR 1 waits on
   ADR 0001's whole client store.
3. **An edited re-send is refused `turn-committed-different-text` and never consumes the draft**
   (§5.2, §9.3, §9.4 change 1). ADR 0001 releases the edit with a fresh turn id, and the stored
   turn keeps its own text. ADR 0001's "typed text is never lost" wins. *Alternative:* answer the
   edit in place of the stored turn; that rewrites a stored message, which neither ADR does
   anywhere else.
4. **A thread delete does not abort an in-flight model** (C5, §5.3). The full answer finishes into
   the Recovered thread, as on dev today, bounded by `TURN_BUDGET_MS`. *Alternative:* abort on
   delete; the Recovered thread then holds a partial answer, billed at least the reserve.
5. **One sweep owns stranded holds: `release-ai-holds`, extended** (§8.2) with the C8 pass, the
   claimed-hold exclusion and retention, at its 15-minute interval, with the corrected comment. No
   second sweep. *Cost:* a crashed turn whose thread nobody opens keeps its reserve for up to about
   17.5 minutes instead of about 3.5 with a one-minute sweep. The next accept on the thread does
   not wait for it.
6. **Widen #5515's `scope:`** to `docs/adr/0003-*.md` (this PR; the issue names `0002-*.md`, which
   went to #5511), and, for PR 1, to `lib/db/schema/agent.ts`, `lib/db/programmables.sql`,
   `lib/billing/ai-guard.ts`, `lib/billing/ai-plan.ts`, `lib/billing/agent-metering.ts`,
   `lib/authz/guard.ts`, `lib/agent/`, `lib/ai/client-tools.ts`, `lib/reconcile/ai-holds.ts`,
   `components/agent/`, the migration, and the test files of §11. A comment on #5515 proposes it.
   PR 1 holds `mutex:migration`.
7. **The turn bound: `TURN_BUDGET_MS = 900_000`** (15 minutes), above the measured six-minute
   deep-reasoning turn. Shorter cuts real turns; longer only delays the release of a dead process's
   claim, which the heartbeat already bounds at 90 s.
8. **Billing a partial answer** (case 14): completed steps at real cost, and **at least the reserve
   (100 credits)** when any model output was stored. Today it is 0, which lets a client read an
   answer and disconnect before its last step finishes.
9. **A crashed attempt's hold, re-asked against what dev does.** Dev already releases it to 0,
   deliberately, after 60 to 75 minutes (`release-ai-holds`, #2683, #3177); revision 1 wrongly
   said it stayed at the reserve forever. **Recommended: keep releasing to 0, sooner** (C8, within
   about 17.5 minutes), so "billed if and only if an answer is stored" holds without exception.
   *Alternative:* keep the reserve as the price of an unknown provider cost; that reverses #2683's
   decision and needs its own ruling.
10. **Claim retention: 30 days** for terminal claims; they hold no text, and the thread's own
    deletion removes them sooner.
11. **The support and agent-identity routes** (§12): include them in PR 1. Their defect is the same,
    `reserveTurn` takes the route's kind and project as parameters, and it gives their holds the
    claim-owned release instead of the age assumption of §8.2.
