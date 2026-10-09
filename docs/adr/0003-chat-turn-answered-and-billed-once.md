<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# A chat turn is answered by the model, and billed, exactly once

**Status:** Accepted (maintainer delegation 2026-10-08; veto window open). Revision 5.1
(2026-10-08); revision 1 was 09021e23f, revision 2 was 4a8e15518, revision 3 was eb4b81a9d, revision
4 was 76eff803b, revision 5 was 78e7483e8. Every open question is answered in §13 next to its question text, so a veto names one Q
number. · **Issue:** #5515 · **Builds on:** ADR 0001 revision 7.1 (#5512, draft persistence), whose
§5.3 defines the hand-off this ADR takes over and states the same contract and slice order as §9.4
and §14 here · **Related:**
ADR 0002 (#5511, payment holds; a different "hold": that one is a Stripe first payment, this one is
the AI budget hold in `ai_usage_ledger`)

**Revision 5.1 (2026-10-08, delta review of revision 5, and the slice-2 builder's finding).** Two
inline blockers and seven advisories. (1) No send reads the widget grid's `pendingCellTarget` slot:
the empty-cell prompt passes its cell in ADR 0001's `SUBMIT_EXTERNAL`, a composer send carries the
draft content's cell (only a failed cell prompt's Retry has one), and slice 9 deletes the dead slot
with `takePendingCellTarget`, so a later turn can never carry a stale target (§9.2). (2) Slice 6
ships `onTurnRefused`'s composer path only; the run-time store check and its `One refusal handler`
test move to ADR 0001 slice 9, the slice in which the store first owns a send (§9.3, §14). (3)
`propose_changes` (the project assistant's canvas proposal, `compose.ts:230-236`) is a third client
tool, with an output schema; its `accepted` is not an accepted approval, because it queues nothing on
the server (§3, §5.1 step 8, §5.2). The classifier's `invalid` row and a Retry through the submit
rows are stated; the approval cards truncate their free text to the schemas; slice 6 validates
`orgId` as a UUID before `resolveTurnActor` and takes `userId` from the session only. Advisories
taken: C4r clears `answer_id`, `partial` and `finished_at`; a resumed tail stays billed (decision
6); a stale-revision resume keeps its Retry (§9.1); the recreate runs C8 first (§5.1 step 2); the
stream's `onError` is a C7 path (§5.3); a new proposal in a partial tail says to approve or reject it
(§9.1); §8.2 names the `maxDuration` exports correctly. Slices 2-4 are unchanged except slice 2's
`propose_changes` and its three-tool-set test. Rejected: none.

**Revision 5 (2026-10-08, independent review of revision 4).** Five inline blockers and nine
advisories. (1) An answer that carries an **accepted approval** is never regenerated wholesale: the
server refuses `regen:a` as `turn-has-accepted-approval`, the UI does not offer Regenerate on it, and
Retry on a partial continuation **resumes** the continuation with the stored approval kept (§5.2,
§9.1), so a second provision can never be queued. (2) Claims are **not** cascaded with the thread:
`thread_id` has no foreign key, a claim outlives a delete for its 30-day retention, and finalize's
token compare-and-set alone decides which route stores and settles, so a delete can no longer let
two attempts both finalize (§4.1, §4.3, §5.3). (3) The org the client names is `currentActor().orgId`
of the page, passed down by the `[org]` layout; the layout's own `resolveOrgScope` id is wrong in
community (§6.1, §10). (4-5) ADR 0001 is revision 7 with numbered slices; every "PR 1/PR 2 of ADR
0001" is now a slice number, `turn-key.ts` has one owner (slice 2 here), every route-level O test
and every existing test a slice breaks is in that slice's scope, and the `mcp` route's `maxDuration`
is in slice 8 (§14). Advisories taken: a throw after acceptance and before the stream finalizes C7,
and a leaked heartbeat cannot pin a hold (an age bound, §5, §8.2); completed steps are collected as
each finishes (§5.3); RLS is `ENABLE`d; approval outputs from the browser have a zod schema and a
size cap (§5.1 step 8); the "fails on dev" rule is restated for new modules (§11); the cross-ADR
file order is named (§14); the support chat is left on today's path until it has threads (§12, Q11);
Q1 states the read-after-removal consequence; the support route never recreates a thread. Rejected:
none.

**Decision.**

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
   of a key.** (A partial continuation's resume replaces its own tail, §5.2. That tail was stored
   and billed when it ended, and stays billed after the resume replaces it, exactly as a regenerated
   answer does: "billed if and only if stored" holds at each finalize, not for every later
   transcript.) The hold is settled **inside** the transaction that wins the `running → answered`
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

Every statement below was read at `f586e91e5`, and revision 4 re-checked the citations at
`e02417059`: of the files cited, `lib/authz/guard.ts`, `Dockerfile` and
`.github/workflows/deploy-console.yml` changed in between; the guard's cited lines still say what
is quoted, and the other two citations are corrected where they are used. None of the files it cites changed between
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
- Nothing identifies the turn. `refId` is the thread id (`route.ts:220-225`), or on the project
  route the thread id when the body names one and the project id otherwise (`threadId ?? projectId`,
  `assistant/route.ts:224-229`). Two requests for one turn reserve two holds and settle two.
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
  (CREATE POLICY, "Notes"). A foreign key from a claim to `agent_threads(id)` would therefore prove
  the thread **exists**, not that the caller **owns** it. #5515 case 8 suggests the opposite; §4.3
  proves ownership by a locked read and, since revision 5, has no foreign key at all.

**Duration.** The console ships as `output: "standalone"` (`next.config.ts:35`) and runs as
`node apps/console/server.js` (`Dockerfile:93`). There is no `vercel.json`. The `maxDuration`
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
| 18 | Thread deleted mid-turn | Covered today by the tombstone. A design hazard, not today's code: a claim cascaded with its thread (revision 4's design) would disappear under a running attempt, and with it the record of which attempt owns the turn (fixed in revision 5, §4.3) |
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
  the browser (`addToolOutput`). There are three, across the three tool sets the routes build:
  - `propose_operation` (`lib/ai/tools/operations.ts:27-31`, rendered by
    `components/agent/render-tool-parts/org-tool-parts.tsx:48-66`), in `buildAgentTools` (the org
    route) and in `buildProjectAgentTools` (the project assistant route, through `operationTools`,
    `lib/ai/tools/index.ts:37-48`);
  - `propose_changes` (`lib/ai/tools/compose.ts:230-236`), in `buildProjectAgentTools` through
    `composeTools`: the user accepts a canvas change in the browser, which applies it there and
    sends `{ status: "accepted", label }`
    (`components/agent/render-tool-parts/project-tool-parts.tsx:119-122`), and `use-agent-chat.ts:75`
    auto-sends that as a continuation. (Revision 5 said `propose_operation` was the only client tool
    on the two Elench routes; the slice-2 builder found `propose_changes`.)
  - `create_support_case` (`lib/ai/tools/support.ts:21-34`), in `buildSupportTools`, which Q11
    brings under the claim.

  Every read tool executes on the server (`lib/ai/TOOLS.md`). The list is one exported constant,
  `CLIENT_TOOL_NAMES` in `lib/ai/client-tools.ts` (a new file), holding all three names and imported
  by every claimed route's tool set and by the transport. A U test pins it against **all three**
  tool sets: the names equal the tools without `execute` in `buildAgentTools`,
  `buildProjectAgentTools` and `buildSupportTools`.
- **Pending client tool calls of an answer `a`**: the tool parts whose tool name is in
  `CLIENT_TOOL_NAMES` and which are not `providerExecuted`, taken from the **last step of `a` that
  holds any such part** (a step is the parts after a `step-start`). For an answer that ends on a
  proposal this is its last step, as revision 4 had it. For an answer whose continuation has run,
  it is still the approval's step, not the continuation's last step, which holds no client tool;
  revision 4 read the last step only, so a partial continuation's set was empty and its Retry fell
  through to `regen:a` (§5.2, "An accepted approval is never regenerated away"). The client and the server compute this set with **one function**,
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
| `thread_id` | `uuid` not null, **no foreign key** | §4.3: a claim outlives its thread's delete, so the token check still decides |
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
| `accepted_at` | `timestamptz` not null | set by C1 and C2; the age bound of C5 and the sweep (§8.2) |
| `created_at`, `updated_at`, `finished_at` | `timestamptz` | |

Constraints and indexes:
- `unique (thread_id, turn_id, attempt_key)`: one row per attempt key, re-armed in place.
- `unique (thread_id) where state = 'running'`: **one running attempt per thread** (case 20).
- `index (lease_until) where state = 'running'`: the expiry sweep.
- `index (hold_id) where state = 'running'`: the age pass's `NOT EXISTS` probe (§8.2).
- `index (finished_at) where state <> 'running'`: the retention pass (§8.2).
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

`agent_turn_claims` gets its own policy in `programmables.sql`, outside the `owner_all` loop. RLS is
`ENABLE`d first, as every policy-bearing table there is (`programmables.sql:1128`, `:1169`); without
it the policy is inert. It is not `FORCE`d, which no table in the repo is. Slice 1's I test asserts
`relrowsecurity` for the table.

```sql
ALTER TABLE public.agent_turn_claims ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_only ON public.agent_turn_claims;
CREATE POLICY owner_only ON public.agent_turn_claims FOR ALL
  USING (user_id = current_setting('app.current_owner', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_owner', true)::uuid);
```

- **The key has no org in it, on purpose.** A thread is its user's (`org_id = owner`,
  `agent.ts:97`) and is listed in every org, so its turn is one turn whichever org's tab drives it.
  Two orgs' tabs sending one turn collide on `(thread_id, turn_id, attempt_key)`, and the policy
  shows both of them the row they collide on. That collision is the claim working. The org the turn
  is billed to is a column (`billing_org_id`), not a visibility rule.
- **Ownership is proved by a locked read.** Acceptance first locks the thread with `SELECT … FOR
  UPDATE … WHERE id = $thread AND user_id = $actor` (§5.1 step 2). A thread the caller does not own is
  `thread-not-found`, and nothing is written. (A foreign key would not have proved it: Postgres skips
  row security for foreign-key checks.)
- **A claim outlives its thread's delete (revision 5).** Revision 4 cascaded claims with the thread.
  The cascade erased the only record of **which** attempt still owned a turn, so after C8 expired
  attempt A and a Retry re-armed the key as attempt B, a delete let both A and B read "no claim and
  a tombstone" and both finalize into Recovered threads: two stored answers and two settles for one
  key, one of them over a hold C8 had already released (#5548 review of revision 4, inline at line
  514). So `thread_id` has **no foreign key**, `deleteThread` and `listThreads`' reap do not touch
  claims, and finalize's compare-and-set on `token AND state = 'running'` decides alone (§5.3).
  Claims are removed only by the sweep's retention pass, 30 days after they end (Q10), and by an
  acceptance that recreates a reaped id (§5.1 step 2). `deleteThread` itself does not change.
- **A recreated thread id starts with no claims.** After a deleted thread's tombstone is reaped (a
  day, `agent.ts:128-143`), an `agent` turn can recreate a row under the same id (§5.1 step 2). That
  acceptance deletes the id's **terminal** claims in its own transaction, so a turn id the old
  thread answered cannot make the new one answer `turn-answered` for a turn it does not hold. No
  claim of the old thread can still be `running` by then: C5 and the sweep end every attempt within
  `TURN_BUDGET_MS` + 90 s of its acceptance (§8.2), far inside the tombstone's day.
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
| C1 | none | accept (§5.1) | every check of §5.1 passes | `running` | insert the claim; reserve the hold; append the user turn if it is not stored; `lease_until = now() + 90 s`; `accepted_at = now()` |
| C2 | `failed` or `expired` | accept for the same key | as C1 | `running` | re-arm in place: new `token`, `attempt_no + 1`, new hold **under the thread's pinned org**, `error := null`, `accepted_at := now()`. `billing_org_id` and `project_id` are rewritten from the thread, which equal the first attempt's, because the pin never changes (Q1) |
| C3 | `running` | accept for the same key | — | unchanged | refuse `turn-in-progress` |
| C4 | `answered` | accept for the same key | not C4r | unchanged | refuse `turn-answered` |
| C4r | `answered`, `partial`, key `continue:a:<P>` | accept for the same key: the **resume** of a continuation that ended partial (§5.2) | `a` is still the last message and `revision = baseRevision` | `running` | re-arm in place as C2 (new token, `attempt_no + 1`, new hold under the pin, `accepted_at := now()`, `error := null`), and clear what `answered` set: `answer_id := null`, `partial := false`, `finished_at := null`, so `check ((state = 'answered') = (answer_id is not null))` holds inside the acceptance transaction. The stored outputs of `P` are kept; nothing is merged. The partial tail's hold was settled when it was stored (C6) and stays billed: that model call ran and was shown, as a `regen:a`'s replaced answer is |
| C5 | `running` | heartbeat (route, every 30 s) | `token` matches, `state = 'running'`, and `accepted_at > now() - (TURN_BUDGET_MS + 90 s)` | `running` | `lease_until = now() + 90 s`. A heartbeat that matches nothing means the claim was expired (C8) or re-armed under another token; the route aborts the model, because its finalize can no longer store. A deleted thread does **not** stop a heartbeat: the claim survives the delete (§4.3), so the route keeps going and its answer reaches the Recovered thread (Q4). The age guard means a heartbeat timer leaked past its attempt (a bug) cannot renew a lease for ever |
| C6 | `running` | finalize with model output | `token` matches and the thread's revision is `accepted_revision` | `answered` | append the answer (for a continuation, replace `a` with its continued form; for C4r's resume, replace only the steps of `a` after the step that holds `P`'s outputs); `revision + 1`; `answer_id`; `partial`; **settle the hold in the same transaction** (§8.1). On a tombstone, the `deleted` branch of §5.3 instead |
| C6m | `running` | finalize with model output | `token` matches, the revision moved (§4.2 forbids it) | `failed`, `error = 'transcript-moved'` | nothing stored; the hold is released to 0 in the same transaction |
| C7 | `running` | finalize without model output (error, abort or timeout before the first model part, **or a throw between acceptance and the stream's registration**, §5.3) | `token` matches | `failed` | `error`; the hold is released to 0 in the same transaction |
| C8 | `running` | lease silent (`lease_until < now()`), **or** the attempt is older than its bound (`accepted_at < now() - (TURN_BUDGET_MS + 90 s)`) | run first by any accept on the thread (under its lock) and by the `release-ai-holds` sweep | `expired` | the hold is released to 0 in the same transaction, `settled_at` stamped as `releaseStrandedAiHolds` does (`ai-holds.ts:68`); the user turn stays stored and unanswered |
| C9 | any | thread row deleted | — | unchanged | nothing: the claim survives (§4.3); a running attempt finalizes through §5.3's `deleted` branch |

A finalize whose compare-and-set matches no row (C6/C7 lost to C8 or to a re-arm) is §8's "lost
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
     `transcript-save.ts:145-158`), then run step 3's C8 on any running claim of the id **first**,
     and only then delete the id's terminal claims (§4.3, "A recreated thread id"), so a claim C8
     ends here is deleted with the rest instead of surviving on the recreated id (§4.3 argues none can
     still be running; this order makes that not matter); when the id is held by another owner (the insert does nothing), refuse
     `thread-not-found`. For `kind = support` a missing row is always `thread-not-found`: dev never
     recreates a support thread (`transcript-save.ts:145-147`), and this ADR does not start to.
   - A tombstone: refuse `thread-deleted`.
   - `kind` or `project_id` (null-safe) differs from the route's: refuse `thread-not-found`.
   - `billing_org_id` is set and is not the org of step 1: the pin was written by a racing first
     turn after §6.1 read it. Roll back and run §6.1 and `reserveTurn` once more; the pin is
     write-once, so the second run locks the pin it read. Otherwise, if it is null, set it to step
     1's org.
3. Run C8 for this thread's running claim if its lease is silent or it is past its bound.
4. Classify the request (§5.2) against the locked transcript, which gives the attempt key, then
   read the claim row of that key: none (C1), `failed`/`expired` (C2), `running` (C3,
   `turn-in-progress`), `answered` and `partial` for a continuation's resume (C4r), or otherwise
   `answered` (C4, `turn-answered`). A refusal returns here; the transaction
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
   **The outputs are browser input, and are validated before they are stored**, because every later
   model call of the thread reads them: one zod schema per client tool, exported beside
   `CLIENT_TOOL_NAMES` (`lib/ai/client-tools.ts`). `propose_operation`'s output is the discriminated
   union the approval card produces (`components/agent/approval-card.tsx:62-86`): `{ status:
   "approved", operation: "plan_project" | "provision_project", projectId: uuid, environmentId: uuid
   | null, jobId: uuid }` · `{ status: "denied", reason: string ≤ 2,000 }` · `{ status: "rejected"
   }`. `create_support_case`'s is the support card's (`support-case-approval-card.tsx:52-63`):
   `{ status: "submitted", caseId: uuid, caseNumber: integer }` · `{ status: "failed", reason: string
   ≤ 2,000 }` · `{ status: "dismissed" }`. `propose_changes`' is the canvas card's
   (`project-tool-parts.tsx:119-122`): `{ status: "accepted", label: string ≤ 2,000 }`. Each output
   is also capped at 4,096 bytes of JSON. A request whose output fails either is refused 400 before
   the hold, and nothing is stored. A card's free text (a `denied` or `failed` reason, which is an
   error message; a change's `label`, which the model wrote) can exceed either bound, so the three
   cards **truncate it client-side** at a character boundary until the output passes both (slice 6:
   `approval-card.tsx`, `support-case-approval-card.tsx`, `project-tool-parts.tsx`); otherwise a long
   error message would make the approval itself unsendable.
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
message is last (a submit or a Retry) or the trigger is `regenerate-message`. The `invalid` row is
checked before every other; among the submit rows, the different-text row is checked first.

**Equal text.** "`u`'s text equals the stored text" is `turnText(u) === turnText(stored)`. There is
**one** `turnText(message)`, in `lib/agent/turn-key.ts`, owned by slice 2 here; ADR 0001 imports it
for `hasTurn` (its §4.2) and defines none of its own. Its definition, stated identically in both
ADRs: the message's `text` parts joined in order with no separator; then U+0000 removed and
`toWellFormed()` (ADR 0001 §4.1's normalization); then `\r\n` and `\r` to `\n`; then trimmed. No
other part type and no `metadata` field takes part. It is applied to **both** sides, so a turn typed
with a trailing newline, stored trimmed by `startConversation` or sent trimmed by the composer,
compares equal. U tests pin the pairs: `turnText of a D12 first send equals the trimmed stored text`
and `CRLF and LF, and a trailing newline, compare equal`.

| Request | Condition on `T` | Attempt key | Outcome |
|---|---|---|---|
| submit or Retry (`regenerate` with no `answerId`) whose last request message is **not** `u` | — | — | `invalid`: the route answers 400, as for a malformed body, before the hold (not a `TurnRefusal`; ADR 0001 D9d reads 400 as a certain refusal). `turnOf` (§9.1) always names the last user message, so only a hand-built request reaches it |
| submit or Retry, `u` is the last request message | `turnId` not in `T`, `revision = baseRevision` | `answer` | accept; step 8 appends `u`. A Retry of a turn that was never stored (its first request was refused before acceptance) is therefore an ordinary first answer |
| submit or Retry | `turnId` not in `T`, `revision ≠ baseRevision` | — | refuse `transcript-stale` (case 6) |
| submit or Retry (`regenerate` with no `answerId`) | `last` is `turnId`, unanswered, and `u`'s text equals the stored text | `answer` | accept; answer the **stored** message, append nothing |
| the same | `turnId` in `T` (answered, unanswered, or being answered), and the text differs | — | refuse `turn-committed-different-text` (case 19, §9.3), with `answered` as stored. The request's text is **not** committed. Checked **before** the two rows around it and before the claim row (§5.1 step 4), so an edited re-send is never read as `turn-answered` or `turn-in-progress`, both of which consume the draft |
| the same | `turnId` in `T` and answered (any later message exists), the text equal | — | refuse `turn-answered` (case 2) |
| regenerate, `answerId = a` | `a` carries an **accepted approval** (below) | — | refuse `turn-has-accepted-approval` (409, `committed: true`, `textCommitted: true`, `answered: true`), checked before the row below |
| regenerate, `answerId = a` | `last` is `a` and `a` answers `turnId`, `revision = baseRevision` | `regen:a` | accept; finalize replaces `a` |
| the same | otherwise | — | refuse `turn-answered`, carrying the stored answer id (case 11) |
| continuation (submit with the assistant message last, `answerId = a`, `toolCallIds = K`) | `last` is `a`; `P = pendingClientToolCalls(stored a)` (§3) is not empty; `K = P`; the request's `a` carries an output for every id of `P`; and **either** no id of `P` has a stored output and `revision = baseRevision` (the first approval), **or** every id of `P` has a stored output and the claim `continue:a:<P>` exists (a retry of that continuation; its claim row then decides: `failed`/`expired` re-arm, `running` is `turn-in-progress`, `answered` is `turn-answered`) | `continue:a:<P>` | accept; on the first approval, step 8 stores **only** the outputs of `P` from the request. On a retry the stored outputs win and the request's are ignored. Outputs for any other tool call (a server tool's, already stored by finalize) are ignored, never compared. When the claim is `answered` with `partial` and `revision = baseRevision`, this is the **resume** (C4r): the model input is `T` with `a` cut after the step that holds `P`'s outputs, and finalize replaces only what follows that step |
| the same | otherwise | — | refuse `turn-answered` (the continuation already ran and its answer moved on, or the request does not match `a`) |

Then the claim row of that key decides (§5.1 step 4, before the busy check): none (C1),
`failed`/`expired` (C2), `running` (C3), or `answered` (C4).

**An accepted approval is never regenerated away (revision 5).** An answer `a` **carries an
accepted approval** when one of its client-tool parts (§3) has a stored output whose `status` is
`approved` (`propose_operation`: a plan or deploy was queued, `approval-card.tsx:56-57`) or
`submitted` (`create_support_case`: a case was opened). `hasAcceptedApproval` reads **only** the
output's `status`, never its other fields, so a stored output that carries one of those statuses
refuses the regenerate whatever else it holds: it errs toward refusing a regenerate, never toward
queuing a second operation. **`propose_changes`' `accepted` is not an accepted approval**: the
change was applied to the canvas in the browser (`project-tool-parts.tsx:117-118`) and queued
nothing on the server, so regenerating that answer cannot run anything twice; the regenerated
answer may propose the change again, and accepting it again is the user's choice. Revision 4 let `regen:a` replace such an
answer wholesale: the regenerate's model input was `T` without `a`, so the model never saw that the
operation was approved and queued, could propose it again, and a second Approve queued a second
provision, while the stored approval output was deleted from the transcript (#5548 review of
revision 4, inline at line 448). Now: the server refuses `regen:a` for such an answer as
`turn-has-accepted-approval`, before the hold; the Regenerate action is not rendered on it (§9.1);
and a continuation that ended **partial** after the approval is retried by **resuming** it (C4r),
whose model input keeps `a` up to and including the approval's step, so the model sees the queued
operation and the stored output is never touched. A `denied`, `rejected`, `failed` or `dismissed`
output queued nothing, so an answer carrying only those may still be regenerated. The R test: `a
partial continuation retried: the approval output is still stored, the model input contains it, and
regenerate of that answer is 409 turn-has-accepted-approval with no hold`.

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
a continuation of `a`, `index.mjs:6485`). For a resume (C4r) it is `T` with `a` cut after the step holding `P`'s outputs. It is never the
client's list. It is converted with `convertToModelMessages(…, {
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
- **The stream's own `onError`**: a throw inside `createUIMessageStream`'s `execute`, after the
  stream is registered and before `streamText` emits (the heartbeat may already be running), is
  routed by that stream's `onError` to finalize as C7, which also clears the heartbeat. Without it
  the claim would stay `running` with a live hold until C8, and a Retry would read
  `turn-in-progress` for up to the age bound.
- **The route threw after acceptance and before the stream was registered**: `resolveAiTier`,
  `readAgentContext`, `convertToModelMessages` over the stored transcript, `buildAgentTools`. Dev
  releases the hold in that `catch` (`route.ts:387-391`); here the same `catch` runs finalize as C7
  (no model output), so the claim is `failed` and the hold released in one transaction, and a Retry
  re-arms it (C2). Without this arm such a throw would leave the claim `running` with a live hold
  until C8.

**The heartbeat's life.** The heartbeat timer starts only once the stream is registered, and the
once-guard that runs finalize also clears it, on every path above, the throw included. A timer
leaked by a bug cannot pin the hold either: C5 renews only an attempt younger than `TURN_BUDGET_MS`
+ 90 s, and C8 (at the next accept, or the sweep) expires an older one whatever its lease (§8.2).

**The steps are collected as they finish.** `onError` receives no steps (dev bills 0 there,
`route.ts:350-367`), and `onAbort` receives only the completed ones. So the route appends each
step's usage to an array in `onStepFinish`, and finalize bills from that array on every path; the
callbacks' own arguments are not the source.

One transaction, in §5's lock order: lock the thread (`SELECT … FOR UPDATE`), then `UPDATE
agent_turn_claims SET state = … WHERE id = $claim AND token = $token AND state = 'running'
RETURNING …`, then, for C6, append the answer under `revision = accepted_revision` and add one,
and **settle the hold on the same `tx`**: `recordAgentTurnUsage` takes `tx` and passes it to
`recordAiUsage`, whose reconcile `UPDATE` and append `INSERT` both run on `getServiceDb()` today
(`ai-quota.ts:318-345`), so `recordAiUsage` takes `tx` too. Its row 0 (the hold,
`agent-metering.ts:141`) and its appended rows are then written before the commit. C7, C6m and C8
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
| `deleted` | the compare-and-set **won** (`token` matches, `state = 'running'`), and the thread row is a tombstone (or gone after its reap) | stored in a "Recovered: …" thread, as today (`transcript-save.ts:123-137`), built from `T` + the answer; the claim is `answered` | settled in the same transaction as the Recovered thread's insert (the user has the answer) |
| `lost` | the compare-and-set matched nothing: the claim was expired (C8) or re-armed under another token | not stored, whether or not the thread was deleted | not touched (C8 released it to 0, or the re-arm owns its own hold) |

**A deleted thread does not stop the model (Q4).** The claim survives the delete (§4.3), so the
heartbeat (C5) still matches it and the route keeps streaming; the **full** answer reaches the
Recovered thread, as it does on dev today. Exactly one attempt can do so: the one whose token still
holds the `running` claim. An attempt that C8 expired before the delete finalizes `lost`, so a
delete can never produce two Recovered threads or two settles for one key (revision 4 could, #5548
review of revision 4, inline at line 514). The turn is still bounded by `TURN_BUDGET_MS` (§8.2), far
inside the tombstone's day.

## 6. The billing org (cases 3, 4, 10, 15)

### 6.1 The resolver

**Which org (Q1).** The request names an org: `orgId` in the body. For Elench it is
`currentActor().orgId` resolved **on the page**: the `[org]` layout calls `currentActor()` and
passes its `orgId` to `AppShell`, which keeps it where the transport reads it at request time
(`orgRef`, §9.1). That is the value ADR 0001's `listDrafts` also answers as `orgId` (its `pageOrg`).
It is **not** the layout's own `resolveOrgScope(slug).orgId` (`app/(private)/[org]/layout.tsx:36-38`,
`app/server/actions/resolve.ts:79-112`), which is the real organization's id for every non-`~` slug,
also in community, where community provisions real orgs with real slugs (`lib/auth/onboarding.ts:34`).
Step 1 below accepts only `orgId === userId` in community, and `resolveNamedOrgScope` refuses every
real org id there (`guard.ts:59-64`), so naming the layout's id would make every community turn from
a team-org URL `org-forbidden`. `currentActor()` collapses it to the user id through its second arm
(`guard.ts:65`), which is what step 1 needs (#5548 review of revision 4, inline at line 954). An O
test pins it: `community, a team-org URL: the transport's orgId is the user id, and the turn is
accepted under the personal actor`. The route reads the thread's
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
acceptance); the next request is refused by §6.1. A member removed from the pinned org also keeps
**reading** what that org's tools already returned into their own transcript, and the widgets
pinned from it: the thread is the user's (§1), and nothing re-reads it on removal. That is true on
dev too, and Q1 records it as a decision, not an omission.

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
error therefore drops every answer, in every org, until it is fixed. Slice 5 logs it as a `log.error`
with the stable message `finalize-metering-failed` (through `lib/observability/log.ts`, as
`meteringFailed` does, `ai-quota.ts:262-269`). The repo has no alert-rule surface (no alerting
config exists under `deploy/` or `infra/`), so the page-on-one-occurrence alert is a log alert the
maintainer configures outside the repo; slice 5 (§14) lists it as a hand-off item.

| How the attempt ends | Transcript | Claim | Billed |
|---|---|---|---|
| Refused before acceptance (400, 403, 404, 409, 410, 413) | unchanged | none, or unchanged | nothing; no hold |
| 402 budget | unchanged (the transaction rolled back) | none | nothing; no hold |
| Model finished | turn + answer | `answered` | the steps' real cost, as today |
| Provider error before any model output | turn, no answer | `failed` | released to 0, as today |
| Provider error after model output | turn + partial answer | `answered`, `partial` | the completed steps collected by `onStepFinish` (§5.3; `onError` receives none); at least the reserve (Q8) |
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
completed (`agent-metering.ts:100-110`). Slice 3 gives it a `floorCredits` input, which finalize
passes as the amount the attempt's hold reserved (`METERED_RESERVE_CREDITS` for every metered chat
kind today) when `partial` is true. The floor is compared with the **sum** of the attempt's rows:
when the steps' total cost is below the floor, row 0 (the hold) is raised by the difference, so
the attempt as a whole costs `max(floor, total)`, also for a multi-model turn whose cost is spread
over several rows (§10 item 3).

### 8.2 The bound and the lease (case 9)

- **The bound.** `streamText` takes `abortSignal: AbortSignal.any([req.signal,
  AbortSignal.timeout(TURN_BUDGET_MS)])`. A timeout fires `onAbort`, so it ends exactly like a
  disconnect (§8.1). Decided: `TURN_BUDGET_MS = 900_000` (Q7): above the six minutes measured
  for a deep-reasoning turn. All three `maxDuration` exports are deleted: the project assistant
  route's (`app/api/projects/[projectId]/assistant/route.ts`) in slice 6, and `app/api/agent/[agentId]/route.ts`'s
  and `app/api/mcp/route.ts:19`'s in slice 8. `app/api/agent/route.ts` exports none on dev.
  (Revision 5 said "the two chat routes'".) So nothing claims a bound it does not have.
- **The bound holds for the hold too.** An attempt older than `TURN_BUDGET_MS` + 90 s since
  `accepted_at` is past its own timeout, so C5 no longer renews it and C8 expires it whatever its
  lease. A heartbeat timer leaked by a bug therefore cannot keep a hold reserved beyond that age
  plus one sweep interval.
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
  1. **Expire silent claims (C8).** Every `running` claim with `lease_until < now()`, or with
     `accepted_at < now() - (TURN_BUDGET_MS + 90 s)`, locked in
     §5's order (thread `FOR UPDATE SKIP LOCKED`, then claim, then ledger row), is set `expired` and
     its hold released to 0 in one transaction per claim.
  2. **Release unclaimed stranded holds,** as today: `settled_at IS NULL` and older than the window
     below, **excluding** any hold that a `running` claim names (`NOT EXISTS (SELECT 1 FROM
     agent_turn_claims WHERE hold_id = l.id AND state = 'running')`). A claimed hold is released
     only by its claim's lease, never by age.
  3. **Retention:** delete terminal claims whose `finished_at` is older than 30 days (Q10),
     whether or not their thread still exists: a deleted thread's claims are kept for the same 30
     days (§4.3).
- **The window, re-derived.** `ai-holds.ts:27-37` derives 60 minutes from "the platform's function
  timeout". That timeout does not exist: the console runs as a standalone Node server, and the
  `maxDuration = 300` exports bound nothing (§1, Duration). The real bounds are these:
  - a chat-route hold after slice 6 is claimed, so pass 2 never reads it; its turn is bounded by
    `TURN_BUDGET_MS` (15 minutes), and its release by C8;
  - every other hold (the support and agent-identity routes until slice 8 moves them, Q11, the `colony` and
    `verify` actions, and a turn that ran on the old process across the deploy) has **no** time
    bound at all. For those, 60 minutes is an assumption, not a derivation.

  60 minutes is kept. It is longer than `TURN_BUDGET_MS` + the 90 s lease + one sweep interval
  (about 32 minutes), so pass 2 could not release a live chat hold even without its exclusion. For
  an unbounded caller that runs past it, an early release costs headroom accuracy only, not money:
  the late settle overwrites the row in place (`ai-quota.ts:318-338`) and the turn is billed once.
  Slice 7 rewrites the comment at `ai-holds.ts:27-37` to say exactly this, and drops its false "books
  the cost twice".
- **`agent.ts:119-123` is corrected** (in slice 1, which already edits that file) to cite the
  15-minute turn bound plus the 90 s lease: a turn streaming at the delete finalizes within about 16
  minutes, far inside the tombstone's day.

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
  `data-turn-finished` part, and through a setter `useAgentChat` returns (`setBaseRevision`), which
  the caller of `createThread` and ADR 0001's `created` outcome (its D12, wired in its slice 9) call
  with the revision they return for the thread row (revision 1 left a new empty row unseeded, so its
  first turn was `transcript-stale` once).
- `orgRef` is read at request time, as `revisionRef` is. Its value is `currentActor().orgId` of the
  page, which the `[org]` layout passes to `AppShell` (§6.1, §10). `useChat` keeps a Chat's first
  transport for the Chat's life (it is recreated only when `id` changes), so a closed-over `orgId`
  would be the first render's. AppShell remounts under the `[org]` layout today, so this is not
  reachable yet; the ref keeps a later shell change from turning it back into case 3.
- **The turn fields are opt-in.** `useAgentChat` sends `orgId` and `turn` only for a caller that
  passes its `org` option (the Elench conversation). The support chat (`support-ask-chat.tsx:27-30`)
  shares the hook and passes none, so slice 6 changes nothing on its wire, and the `fetch` wrapper
  throws `TurnRefusedError` only on a typed refusal body, which the support route never sends (§12,
  Q11).

- **Regenerate passes the answer it replaces.** `regenerate()` slices that answer off before the
  transport runs, so the call changes to `regenerate({ messageId: answer.id })`. The call is
  `elench-conversation.tsx:464` (`onRegenerate`); `agent-chat.tsx:376-380` renders the action on the
  last message and calls `onRegenerate` with no argument, so `onRegenerate` becomes
  `(messageId: string) => void` and the action passes `m.id`. A tab can therefore only regenerate the
  answer it displays (case 11). **The action is not rendered on an answer that carries an accepted
  approval** (`hasAcceptedApproval(m)`, `turn-key.ts`, §5.2), which the server refuses anyway.
- **The error card's Retry** (`elench-conversation.tsx:302`) is chosen by what is last:
  - a **user** message (an unanswered turn): `regenerate()` with no `answerId`, an `answer`
    attempt (§5.2);
  - an **assistant** message whose pending client tool calls (§3) are **not empty** and all have
    outputs (a failed continuation, or one that ended partial after model output; an empty set
    would match every plain answer vacuously): the continuation request again (trigger
    `submit-message`, the assistant message last, as `addToolOutput`'s auto-send makes it), which
    §5.2 re-arms (C2) or resumes (C4r) with the stored outputs kept;
  - an **assistant** message whose pending client tool calls are not empty and **lack** outputs (a
    partial continuation whose tail proposed something new): no Retry. The card reads "Approve or
    reject the proposal above to continue." The card is still approvable, and its continuation is
    the way on; `regen:a` would be refused `turn-has-accepted-approval` when the earlier step holds
    an approval (#5548 delta review of revision 5, advisory 6);
  - any other **assistant** message (a partial answer after a provider error):
    `regenerate({ messageId })`, a `regen:a` attempt. Revision 2's plain `regenerate()` sliced the
    answer off and was refused `turn-answered`, so Retry became a silent reload.
- **A resume sent from a stale revision does not dead-end.** A continuation that ended partial on a
  network drop never delivered `data-turn-finished`, so the tab's `revisionRef` is the acceptance's,
  one behind, and its Retry is answered C4 `turn-answered` (C4r needs `revision = baseRevision`).
  The server keeps that answer (it is `committed: true`, before the hold, and costs nothing). The
  client recovers: when a **continuation** request is refused `turn-answered` and the refusal's
  `revision` differs from the request's `baseRevision`, `onTurnRefused` loads the transcript (which
  refreshes `revisionRef`) and **keeps** the error card and its Retry, reading "This conversation
  changed while the answer was being continued. Retry to continue it." The next Retry carries the
  current revision: a partial continuation is resumed (C4r), and a finished one is refused
  `turn-answered` with a matching revision, which clears the card as any `turn-answered` does. So the
  user is never left without a way to resume, and no request is ever sent without a click.
  (Revision 5 cleared the card on every `turn-answered`, so after the load the user had no Retry,
  and Regenerate is not rendered on an answer that carries an accepted approval; #5548 delta review
  of revision 5, advisory 3.)
- **The continuation needs no new client id.** Its key is derived from the stored answer and its
  pending client tool calls, so two tabs that approve the same card make the same key and one of
  them is refused (case 7), and a server read tool in the same step does not enter the key (case
  7b).

### 9.2 Mentions and the cell target move to the message (case 13)

The routes read the mentions and the cell target of the turn's **stored** user message (§5.2),
validated with `mentionsSchema` and the existing cell schema. Where each comes from depends on what
the sends carry, and revision 1 overstated that:

| Field | ADR 0001 revision 7.1 writes it into `metadata` on | Slice 6 reads | Deleted from the body by |
|---|---|---|---|
| `mentions` | the first turn (`startConversation`, its §5.1 step 3), every later composer turn (D9b) and every external send (D10x, D10y) | `metadata.mentions`, else `body.mentions` | slice 9, after ADR 0001 slices 7b and 9 (which ship D9b and D10y and wire them) |
| `cellTarget` | an external start (D10x) and an external send into an existing conversation (D10y, the empty-cell prompt's path), both from the `SUBMIT_EXTERNAL` event; and a composer turn (D9b, D10b) whose draft **content** carries one, which only the Retry of a failed cell prompt does (ADR 0001 D10f). Never from the widget grid's `pendingCellTarget` slot | `metadata.cellTarget`, else `body.cellTarget` | slice 9, after ADR 0001 slices 7b and 9 (§9.4, change 3), which also deletes `takePendingCellTarget` and the slot |

The empty-cell prompt sends into the **current** conversation, usually an existing thread with
widgets (`elench-conversation.tsx:313-324`): it stages the cell and sends the text, an **external**
send, never a composer one. Until ADR 0001's D10y carries the target (its slices 7b and 9),
`body.cellTarget` (from `takePendingCellTarget()`, `:172`) is the only path for it, and deleting it
would land the widget by first-fit instead of in the cell the user clicked: the (0,0) regression
recorded at `:169-172`. (Revision 4 assigned the target to D9b, which a cell prompt never takes.)

**No stale target (revision 5.1).** On dev the slot has one writer, the empty-cell effect
(`elench-conversation.tsx:322`), and one reader, `takePendingCellTarget()` in `prepareBody`
(`:55-58`, `:172`), which reads **and clears** it in the same request. Revision 5 had ADR 0001's
D9b and D10y read the slot without clearing it, and slice 9 here deleted the only take, so every
later turn would have carried the last clicked cell (#5548 delta review of revision 5, inline at
line 905). Now no send reads the slot at all: ADR 0001's slice 9 makes the effect pass the cell in
`SUBMIT_EXTERNAL` and stop staging it, so from then on nothing writes the slot, `prepareBody`'s take
returns null, and the route reads the target from the message's metadata. Slice 9 here then deletes
the dead slot (`pendingCellTarget`, `setPendingCellTarget` in `lib/stores/use-widget-grid-store.ts`)
with `takePendingCellTarget` and `body.cellTarget`. A refused cell prompt keeps its cell in the
draft's content (ADR 0001 D10f), not in the slot.
The fallback is read for the **acceptance's** user message only, and §5.1 step 8 writes it into
that message's `metadata` as it appends, so the stored turn carries its target from then on (a
Retry of it needs no body). A stored message's metadata always wins. Tests: R › `a later-turn cell
prompt with body.cellTarget and no metadata lands in the named cell` (slice 6); C › `the empty-cell
prompt, driven through pendingCellRequest into an existing thread, stores its cell target in the
user message's metadata and the route reads it with no body field` (slice 9); C › `after a cell
prompt, the next composer turn's stored message has no cellTarget` (slice 9; ADR 0001 slice 9's S9
test is the same sequence before the slot is deleted).

### 9.3 Refusals (case 12)

Every refusal before acceptance is a JSON body:

```ts
type TurnRefusal = {
  refusal: "turn-in-progress" | "turn-answered" | "turn-committed-different-text"
         | "thread-busy" | "transcript-stale" | "thread-deleted" | "thread-not-found"
         | "org-forbidden" | "project-not-found" | "client-outdated"
         | "turn-has-accepted-approval";
  turnId: string | null;
  committed: boolean;      // a turn with this id is in the stored transcript
  textCommitted: boolean;  // ...and its text is the text this request sent
  answered: boolean;       // ...and it has an answer
  revision: number | null;
  answerId: string | null;
};
```

Statuses: 409 for the first five, `client-outdated` and `turn-has-accepted-approval`, 410
`thread-deleted`, 404 `thread-not-found` and `project-not-found`, 403 `org-forbidden`.

**The order of refusals.** A route answers, in this order, and each before the budget hold: 401 (no
session) and 503 (AI not configured), as on dev; 400 for a malformed body; 413 for a last user turn
over the cap (`refuseUserMessage`, as on dev); 409 `client-outdated` (no `orgId` or no `turn`); 400
for an approval output that fails its schema (§5.1 step 8); 403 `org-forbidden` (§6.1); 404
`project-not-found` (§6.2); then `reserveTurn`'s own refusals (§5.1 steps 2-5) and 402 for the
budget (step 7). So `tests/api/agent-message-limit.test.ts`, which posts `messages` alone and
asserts 400 and 413, still gets them: they come before `client-outdated`. **This is ADR 0001 §5.3's second
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
| `turn-has-accepted-approval` | true | answers a regenerate only, never a send, so no draft is involved: load the transcript; "This answer started an approved operation, so it cannot be regenerated." The UI does not offer Regenerate there, so only a stale tab sees it |

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

**The client half without ADR 0001's store (slice 6).** `useAgentChat` gets a `fetch` wrapper that
reads the typed body and throws a `TurnRefusedError`. Elench and any surface without ADR 0001's
store (the support chat, if it adopts this, §12) handle it in one function, `onTurnRefused` (in
`elench-conversation.tsx`, beside the `restore` handle it calls):
`loadInto` the thread (which refreshes `revisionRef`), `clearError()`, and, on every refusal whose
`textCommitted` is false, put the refused text back into the composer through its existing
`restore` handle (`elench-conversation.tsx:289-292`) with the table's notice. A refused **cell
prompt** also restores its cell target, which `takePendingCellTarget()` consumed when the body was
built (`:172`): `onTurnRefused` re-stages it with `setPendingCellTarget`, so the next Enter lands
the widget in the cell the user clicked. That re-staging lives only as long as the composer path:
from ADR 0001's slice 9 on, a cell prompt is a store-owned D10y send, its refusal goes to the store
(below), and D10f keeps the cell in the draft's content. On `turn-in-progress`, the loaded transcript ends on a
user turn, so it shows "Being answered in another tab or device" instead of the `unanswered` rule's
"No reply arrived" (`:223-229`), and polls `getThread` every 5 s until `inFlight` is null, then
loads again. No error card is shown, and a Retry is never needed to recover, because the reload
already refreshed the base revision.

**Exactly one handler.** Slice 6 here ships the composer path **only**: no ADR 0001 store exists
when it lands (the store is ADR 0001's slice 8, and first owns a send in its slice 9), so there is
nothing to check, and a test of the check could only run against a fake. **ADR 0001's slice 9**, the
slice in which the store first owns a send and which already edits `elench-conversation.tsx`, adds
the check: when the store holds a `sending` entry for the refused turn id (a composer send, D9d, or
an external one, D10f), `onTurnRefused` dispatches the refusal to the store (D9d, D10f, D20) and does
nothing else; the composer path runs only when no store owns the send. So one refusal never reaches
both D9d's release and `restore`, whose merge (D11r) would show the text twice. Its C test, `One
refusal handler`, is ADR 0001 slice 9's. Slice 9 here then deletes the composer path. (Revision 5
put the check and its test in slice 6, which does not wait for the store; #5548 delta review of
revision 5, inline at line 1451.)

### 9.4 What ADR 0001 carries for this ADR (adopted in its revisions 6, 7 and 7.1)

ADR 0001 revision 5.1 could not carry this ADR's refusals as written. Revision 6 adopted the four
changes below; revision 7 corrected two of them (the certain list of change 2 and the path of
change 3), and revision 7.1 corrected change 3 again (no send reads the pending slot) and gave the external sends failure arms (D10f). Its §5.3 states the same contract from its side; a change to either side changes both
documents.

1. **An edited re-send releases with a fresh turn id; it is never consumed** (Q3). D9d's arm (d)
   for `turn-committed-different-text`: `releaseClaim(token, error, { freshTurnId })`, with the
   new id minted by the client. With `freshTurnId`, S4 never redirects to S3: content kept, claim
   cleared, `failed_send := { turnId: freshTurnId, …, uncertain: false }`. The same rule applies to
   S5 (the lease settle) and to S4's redirect without `freshTurnId`: a later turn whose id is in the
   transcript is consumed only when `turnText` of the stored message equals `turnText` of the
   claimed text (`hasTurn`, the one function of §5.2 on both sides); otherwise it is released with
   a null turn id, and the next claim mints a fresh one. R10 is amended: a corrected re-send carries
   the same turn id **until** the route answers `turn-committed-different-text`, and from then on
   the edit is a new turn. "Never re-minted for a stored turn" still holds: the fresh id names the
   edit, which is not stored. Tests (ADR 0001): S9 › `an uncertain later turn stored by a late
   acceptance, edited and re-sent: turn-committed-different-text keeps the edit in the box under a
   new turn id, and Enter sends it as a new turn`; A › `the lease settle releases, not consumes, a
   claim whose stored turn has different text`.
2. **D9d's certain-release list** is the routes' own pre-hold refusals (401, 503, 400, 413, 402;
   there is no 429) plus this ADR's `committed: false` refusals: 409 `thread-busy`,
   `transcript-stale` and `client-outdated`, 410, 404 and 403. Without it they release
   `uncertain: true` and D31 says "may already have been sent", which is false.
3. **The cell target rides the message on the path the cell prompt takes**: ADR 0001's D10y (an
   external send into an existing conversation) and D10x send `metadata.cellTarget`, taken from the
   `SUBMIT_EXTERNAL` event; a composer send (D9b, D10b) sends its draft content's `cellTarget`, which
   only a failed cell prompt's Retry carries (D10f). No send reads the pending slot, and from ADR
   0001's slice 9 on nothing writes it (§9.2). So the body fallback of §9.2, and the slot, can go in
   slice 9. A refused or failed cell prompt lands in the box with its cell (D10f), so nothing is lost
   once the composer path is deleted.
4. **`startConversation`'s `created` returns the thread's revision**, read from the inserted row,
   so the transport's base revision is seeded (§9.1). It is never null, because slice 1 here (the
   `revision` column) lands before ADR 0001's slice 1.

**The dependency, in slice numbers** (ADR 0001's slices are "0001/<n>"; ADR 0001 §5.3 and §14 state
the same order):
- **Slice 6 here** (the first slice that answers a refusal) is blocked by **0001/4** (the server
  half of change 1: S4's `freshTurnId` and null-id arms, S5's text-aware `hasTurn`) and **0001/7b**
  (the client half: D9d's four arms with change 2's list). 7b is a reducer with no caller until
  0001/8-9; until then slice 6's own `onTurnRefused` composer path is the only client, and it never
  consumes a draft. Slices 1-5 and 7 return no refusal to any client and may merge before. Gating
  on D9d alone is not enough: a tab that re-sends an edit under the old turn id and dies before the
  refusal arrives leaves its draft to the S5 lease, which would otherwise find the old id in the
  transcript and consume the edit.
- **Slice 9 here** is blocked by **0001/7b** and **0001/9** (the store owns every send, D10f
  handles an external send's refusal, D10y carries the cell target, change 3, and 0001/9 adds the
  one-handler check of §9.3).
- **0001/1** is blocked by slice 1 here (both edit `lib/db/schema/agent.ts`, `programmables.sql` and
  the migrations; change 4 reads slice 1's column). **0001/4** is blocked by slice 2 (`turn-key.ts`)
  and slice 4 (`resolveTurnActor`, which its heartbeat route uses). **0001/9** is blocked by slice 6
  (the same client files; it wires change 4 through slice 6's `setBaseRevision`, and adds §9.3's
  one-handler check to slice 6's `onTurnRefused`).

## 10. Migration and rollout (via the db pipeline)

Two phases, PR 1 and PR 2. §14 cuts them into PR-sized slices (slices 1-8 are PR 1, slice 9 is PR 2); the
items below say **what** each phase changes, §14 says in which slice. Only the schema slice, slice 1,
holds `mutex:migration` (`.claude/skills/db-pipeline/SKILL.md`).

**PR 1: the server, and the transport fields the server requires.**
1. Rebase onto `origin/dev`. Add `agentTurnClaims`, `agentThreads.revision` and
   `agentThreads.billingOrgId` to `lib/db/schema/agent.ts`. Generate in one worktree (`pnpm -F console db:generate`, which runs
   `scripts/db-generate.sh` under its lock), then `pnpm -F console check:migrations`. The column
   default backfills every row with revision 1.
2. `programmables.sql`: `ENABLE ROW LEVEL SECURITY` on `agent_turn_claims` and the `owner_only`
   policy of §4.3, idempotent (`DROP POLICY IF EXISTS`).
3. `lib/agent/turn-claims.ts`: `reserveTurn`, `heartbeatTurn`, `finalizeTurn`, `expireSilentTurns`.
   `lib/agent/turn-key.ts`: `pendingClientToolCalls`, `hasAcceptedApproval` and `turnText` (the one
   definition both ADRs use), imported by the routes, the transport and ADR 0001's claim actions.
   `lib/ai/client-tools.ts`: `CLIENT_TOOL_NAMES` and one output schema per client tool (§5.1 step
   8), with a U test that the names equal the set of tools in both routes' tool sets that have no
   `execute`.
   `lib/billing/ai-guard.ts`: extract `reserveAiHold(tx, …)`; `assertAiAllowed` keeps its signature
   for its other callers and calls it. `resolveAiPlan`/`getOrgBilling` and `recordAgentTurnUsage`
   take an optional `tx` (§5.1 step 7, §5.3), and so does `recordAiUsage` (`lib/billing/ai-quota.ts`),
   which `recordAgentTurnUsage` calls; `recordAgentTurnUsage` also takes `floorCredits` (§8.1) and
   leaves `recordAiUsage`'s side effects to run after the commit.
4. `lib/authz/guard.ts`: `resolveTurnActor` (§6.1).
5. Both routes: `orgId` and `turn` required, the project check (§6.2), `runWithActor`, `reserveTurn`,
   the stream built from the stored transcript, finalize before `finish`, the heartbeat, the
   timeout, typed refusals in §9.3's order. `maxDuration` removed. `lib/agent/transcript-save.ts` and
   `thread-transcript.ts`: `appendLive` / `replaceLast`; the recover branch kept.
6. `app/server/actions/agent.ts`: `getThread` returns `revision` and `inFlight`; `createThread`'s
   rewrite bumps `revision` and does nothing while a claim runs (§4.2); `createThread` returns the
   revision; the `:119-123` comment. ADR 0001's slice 5 also edits this file (`deleteThread`'s draft
   purge); it lands after slice 1 here (§9.4), so it rebases over it.
7. The client fields of §9.1 in `use-agent-chat.ts` (opt-in, with `setBaseRevision`) and
   `elench-conversation.tsx`, the page org from the `[org]` layout's `currentActor().orgId` through
   `AppShell`, and the two `regenerate({ messageId })` call sites. They ship with the server because the server refuses a
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

**PR 2: the client half on ADR 0001's store.** Needs ADR 0001 slices 7b and 9 (§9.4).
`onTurnRefused` dispatches to the store (D9d's new arms, D20) and its composer path is deleted, so the
"Being answered" state (shown by slice 6's composer path since PR 1) becomes the store's D20;
`body.mentions`, `body.cellTarget`, `takePendingCellTarget`, the `pendingCellTarget` slot and the
`pendingMentions` slot deleted, and the routes read metadata only; optionally the transport sends only the last message.

**Rollout.**
- **Open tabs on the old bundle.** After PR 1 deploys, a tab loaded before it sends no `orgId` and no
  `turn`. The route answers 409 `client-outdated` before the hold, and the old bundle shows it as an
  error card with the text "Reload to continue". Nothing is billed under a guessed org. (Today's
  bundle cannot read the typed body; its error card shows the response text.)
- **Order against ADR 0001.** PR 1 needs the page's org id on the client. It does not wait for ADR
  0001's `pageOrg`: the `[org]` layout calls `currentActor()` and passes its `orgId` to `AppShell`
  (§6.1; today the layout resolves `resolveOrgScope(slug).orgId` and uses it only for
  `orgHasSelfRunners`, `layout.tsx:36-56`, which is the wrong id in community). PR 1 does not need
  ADR 0001's store otherwise (it carries its own recovery, item 8); §9.4 names exactly which ADR
  0001 slices each of its slices waits for.
- **No data migration.** Existing threads start at revision 1, unpinned, with no claims.
- **The deploy window has two shapes, and neither is clean.**
  - The helm chart's console `Deployment` (`deploy/helm/alethia/templates/console.yaml`) declares no
    strategy, so Kubernetes' default RollingUpdate runs the old and the new pod side by side. A turn
    on the old pod holds no claim and saves wholesale when it ends, which can overwrite turns the
    new pod appended meanwhile, and its tab's "Reload to continue" (on the new bundle) may show
    "No reply arrived" for a turn still being answered; a Retry there is a second answer and a
    second hold. Its hold is unclaimed, so `release-ai-holds`' age pass covers it if it strands.
  - Production's compose deploy (`docker compose … up -d`, `.github/workflows/deploy-console.yml:1363`; revision 3 cited `:1316`, which the file has since moved off) replaces the
    container and kills every in-flight turn. Their holds are unclaimed and are released by the age
    pass after 60 to 75 minutes; their user turns, saved only at the end on dev, are lost.

  Both are bounded to the turns in flight during one deploy, and both disappear once the old
  process is gone.

## 11. Cases, mechanisms and tests

**Test files** (paths under `apps/console/`; each belongs to one slice of §14):
- **R**: `tests/api/agent-turn-routes.test.ts` (slice 6; extended by slice 9). Slice 8's routes have their own file, `tests/api/support-turn-routes.test.ts`. Both routes,
  with ai's mock language model and `reserveTurn` over an in-memory fake with real lock and
  compare-and-set semantics. **The route-level org and project tests of cases 3 and 4 are R tests**
  in this file (they need a route, a claim and a hold), and so is the community team-org URL test
  of §6.1.
- **O**: `tests/api/agent-turn-org.test.ts` (slice 4). The resolver alone, with a community
  resolver and an enterprise-shaped one (`ee/src/scope.ts`'s fallback).
- **U**: `tests/lib/agent/turn-key.test.ts` (slice 2: the classifier, `turnText`,
  `pendingClientToolCalls`, `hasAcceptedApproval`, the output schemas) and
  `tests/lib/agent/turn-claims.test.ts` (slice 5: the transitions as a pure function).
- **I**: `tests/integration/agent-turn-claims-schema.test.ts` (slice 1: constraints, RLS enabled,
  the policy, `getThread`), `tests/integration/agent-turn-claims.test.ts` (slice 5: the lock order,
  the hold in one transaction, the delete sequence), `tests/integration/ai-hold-tx.test.ts` (slice
  3) and the existing `tests/integration/ai-hold-sweep.test.ts` (slice 7).
- **T**: `tests/lib/agent/transcript-save.test.ts` and `tests/lib/agent/thread-transcript.test.ts`
  (existing, extended in slice 5).
- **C**: `tests/components/agent-turn-refusal.test.tsx` (slice 6; extended in slice 9). The
  transport and the client half.

**"Fails on dev", stated for new modules.** Every test is red on its slice's **base** and green on
the branch, and on the branch it reaches its assertion. Concretely: revert the slice's non-test diff
and run the test. For a behaviour the slice changes (the routes, `assertAiAllowed`, the sweep,
`getThread`), it must fail on its assertion, not at import. For a module the slice creates
(`turn-key.ts`, `client-tools.ts`, `turn-claims.ts`, `resolveTurnActor`), the reverted run fails at
import, which is the only way it can; the branch run must then reach an assertion, so a test that
would pass with the import stubbed out does not count. (Revision 4 required every test to fail "on
its assertion, not at import", which no test of a new module can.)

Only R and O fall inside #5515's original `scope:` globs. Q6 widens it, and §14 gives each slice
its exact globs.

| # | Case | Mechanism | Test |
|---|---|---|---|
| 1 | Lost `startThread` response, Retry bills twice | The first turn is stored by `startConversation` (ADR 0001); a Retry is an `answer` attempt on a stored, unanswered turn (§5.2); two Retries share one key | R › `two Retries of a stored first turn: one model call, one hold, the second answers turn-in-progress` |
| 2 | Duplicated tab retries an answered turn | C4 `turn-answered`; nothing written | R › `tab B retries a turn tab A answered: 409 turn-answered, no hold row, A's answer still stored` |
| 3 | Session org bills the turn | §6.1: the body names the org of a first turn (the page's `currentActor().orgId`), the thread's pin every later one; no session fallback | R › `session on B, request names A: the hold, the ledger rows and the claim are A's`; R › `a turn pinned to A, retried from org B's tab: the re-armed hold, the claim and the tools are A's` (C2, Q1); R › `a caller who left the pinned org: 403 org-forbidden before the hold`; R › `community, a team-org URL: the transport's orgId is the user id, and the turn is accepted under the personal actor` |
| 4 | Project not checked before the hold | §6.2, before `reserveTurn` | R › `a project of org B named under org A, by a member with an org-wide project:view grant: 404 project-not-found and no hold row` |
| 5 | Two attempts reach the model | The thread lock + C3 | I › `two concurrent accepts of one turn: one running claim, one hold row, one turn-in-progress` |
| 6 | A stale tab's new turn replaces newer turns | §5.2 `transcript-stale`; §7 append under `revision` | R › `a new turn at an old baseRevision: 409 transcript-stale, no hold, the stored transcript unchanged`; T › `appendLive never writes a client list` |
| 7 | HITL continuation | `continue:a:<P>` (§3, §5.2); finalize before `finish` (§5.3) | R › `approve a plan card: the continuation is accepted after an answered turn and its outputs are merged`; R › `the same card approved in two tabs: one continuation, one turn-answered`; R › `a continuation aborted before its first token: the approval output stays stored, the card is resolved after a reload, and a retry of the continuation re-arms continue:a:<P>`; C › `Retry on a failed continuation resends the continuation, not regenerate()`; R › `a partial continuation retried: the approval output is still stored, the model input contains it, and regenerate of that answer is 409 turn-has-accepted-approval with no hold`; C › `Retry on a partial continuation resends the continuation, and Regenerate is not shown on an answer with an accepted approval`; R › `an approval output that fails its schema or exceeds 4,096 bytes: 400, nothing stored, no hold` |
| 7b | HITL continuation from a mixed step | `pendingClientToolCalls` reads names, not output presence, on both sides (§3, §9.1) | R › `a last step with list_projects (output stored) and propose_operation: the approval is accepted under continue:a:<proposal id>, the proposal's output is merged, and list_projects's stored output is unchanged`; U › `turnOf over the client copy and the classifier over the stored answer derive the same key for a mixed step`; U › `CLIENT_TOOL_NAMES equals the routes' tools without execute` |
| 8 | Claim key vs RLS | §4.3: user-only policy, `ENABLE`d, over an org-free key; ownership by a locked read; no FK, so claims outlive a delete | I › `one turn driven from org A and org B: the second accept sees the first claim and refuses`; I › `deleteThread leaves the thread's claims, and the retention pass removes them after 30 days`; I › `a claim on another user's thread id is refused`; I › `RLS is enabled on agent_turn_claims`; I › `an agent turn that recreates a reaped thread id deletes that id's terminal claims` |
| 9 | `maxDuration` is not a bound | §8.2: in-route timeout, 30 s heartbeat, 90 s silence | R › `a turn running past 90 s with heartbeats keeps its claim; a Retry answers turn-in-progress`; R › `TURN_BUDGET_MS fires onAbort and finalizes partial` |
| 10 | Named-org resolver | `resolveTurnActor` (§6.1) | O › `enterprise: a suspended member naming their former org is 403 before the hold, not billed to their personal org`; O › `community: orgId = userId resolves` |
| 11 | Regenerate re-bills; stale tab | `regen:a` requires `a` to be the stored last answer (§5.2, §9.1) | R › `regenerate of a displayed answer is billed once`; R › `regenerate from a tab that never saw the newer answer: turn-answered` |
| 12 | The client half of a refusal | §9.3; PR 1's `onTurnRefused` (§10 item 8) | C › `turn-answered loads the transcript and shows no error card`; C › `transcript-stale reloads the transcript, restores the text, shows no error card, and the next Enter is accepted`; C › `turn-in-progress shows Being answered and reloads when inFlight clears` (slice 6, composer path; slice 9 re-runs it with the store owning the send) |
| 13 | Mentions, `trigger`, `messageId` | §9.1, §9.2 | C › `the request carries trigger, turnId, answerId, toolCallIds and baseRevision`; R › `mentions are read from the stored user message's metadata`; R › `a later-turn cell prompt with body.cellTarget and no metadata lands in the named cell` |
| 14 | Stream then disconnect, billed 0 | §8.1: `partial` answer billed, floor the reserve | R › `abort after model output: answered partial, hold settled to at least the reserve`; C › `Retry after a partial answer with no client tool output is regenerate({ messageId })`; R › `a provider error after two completed steps bills those two steps, collected by onStepFinish` |
| 15 | Nested `currentActor()` | `runWithActor` (§6.3) | R › `a tool executed in step 2 resolves the named org while the session names another` |
| 16 | Crash: the hold sits at the reserve for an hour | C8 releases to 0 at the next accept, or at the next `release-ai-holds` run (§8.2) | I › `a silent running claim is expired by the next accept and its hold is 0`; I › `release-ai-holds expires a silent claim and releases its hold`; I › `release-ai-holds' age pass skips a hold a running claim names` |
| 17 | Auto-send before the save | Finalize before `finish` (§5.3) | R › `no finish chunk is written before the claim is answered` |
| 18 | Thread deleted mid-turn | The claim survives the delete; the heartbeat keeps matching; only the compare-and-set winner finalizes `deleted` (§4.3, §5.3, Q4) | R › `delete during a turn: the model is not aborted, the full answer lands in a Recovered thread and is billed once`; I › `C8 expires attempt A, a Retry re-arms B, the thread is deleted: A's finalize is lost and stores and settles nothing, B's lands in one Recovered thread and settles once` |
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
| One refusal handler (**ADR 0001 slice 9**, §9.3; not slice 6) | C › `with ADR 0001's store owning the send, onTurnRefused dispatches to the store and does not restore the composer` |
| No stale cell target (slice 9) | C › `after a cell prompt, the next composer turn's stored message has no cellTarget` |
| C4r clears what `answered` set | U › `a resume re-arms with answer_id null, partial false and finished_at null` (slice 5) |
| A stale-revision resume (slice 6) | C › `a continuation refused turn-answered with a newer revision loads, keeps the card and Retry, and the next Retry is accepted as a resume` |
| A new unresolved proposal in a partial tail (slice 6) | C › `a partial continuation whose tail holds an unanswered proposal offers no Retry and says to approve or reject it` |
| The stream's own `onError` (slice 5) | R › `a throw inside the stream's execute before the model emits: failed, hold 0, heartbeat cleared` |
| Recreate after C8 (slice 5) | I › `a recreate of a reaped id runs C8 first and leaves no claim of the old thread` |
| The `invalid` row (slice 2) | U › `a submit whose last message is not the turn classifies invalid` |
| A Retry of a never-stored turn (slice 2) | U › `a Retry whose turn is not stored, at the current revision, is an answer attempt that appends it` |
| `propose_changes` (slice 2) | U › `CLIENT_TOOL_NAMES equals the tools without execute in buildAgentTools, buildProjectAgentTools and buildSupportTools`; U › `an accepted propose_changes is not an accepted approval` |
| Client-side truncation (slice 6) | C › `a denied reason longer than the cap is truncated so the continuation is accepted` |
| C3 before `thread-busy` | U › `a duplicate of a running turn is turn-in-progress, not thread-busy` |
| `getThread` | I › `getThread returns revision and inFlight, and no inFlight for a silent claim` |
| C7 on a pre-stream throw | R › `a throw in buildAgentTools after acceptance: the claim is failed, the hold is 0, no heartbeat keeps running, and a Retry re-arms` |
| C5/C8 age bound | U › `a heartbeat for an attempt older than TURN_BUDGET_MS + 90 s renews nothing`; I › `release-ai-holds expires a running claim past its age bound although its lease is fresh` |
| C4r resume | U › `a continuation whose claim is answered and partial is resumed (C4r), not refused turn-answered` |
| Refusal order | R › `a body with messages alone still gets 400 and 413 before client-outdated` |

**Count.** 21 cases: the 13 of #5515 (1-12 and the addendum) and 8 found while reading the code
(14-21), plus 7b from the review of revision 1. Each has a mechanism and at least one named test.
Five wrong-code facts are corrected on the way: the `maxDuration` exports (deleted, §8.2), the
`agent.ts:119-123` comment (§8.2), the `ai-holds.ts:27-37` comment's "platform's function timeout"
and its "books the cost twice" (§1, §8.2), and `currentActor()`'s missing named-org arm (not added
to it; the routes use `resolveTurnActor`, §6.1). Revision 1 itself stated one wrong fact, that
nothing releases a crashed turn's hold; §1 now describes `release-ai-holds`.

## 12. Out of scope

- **`/api/support/ask` and `/api/agent/[agentId]`** have the same four facts (§1) and are outside
  #5515's original `scope:`. `[agentId]` has no console caller at `f586e91e5`. Q11 decides that they
  move onto `reserveTurn` too, in their own slice after the Elench routes (§14, slice 8), **for a
  request that names a thread**. The console's support chat names none: it sends `messages` only
  (`support-ask-chat.tsx:27-30`), the route saves a transcript only "when set" (`support/ask/
  route.ts:28`), and nothing in the console creates a `kind = support` thread. A threadless turn has
  no transcript to claim against, so it keeps today's per-request hold, released by the age pass if
  it strands. Giving the support chat threads is a product change (support transcripts at rest),
  filed as a follow-up, not decided here.
- **A disconnect that does not cancel.** A closed tab aborts the model today, and this ADR keeps
  that, because a disconnect and Stop look the same to the route. Running on after a disconnect,
  with a separate cancel endpoint for Stop, would let a reload pick up the full answer. It is a
  product change and is not proposed here.
- **Two tabs approving one deploy card.** This ADR makes the continuation run once. Whether the
  approval's own server action (the plan or deploy it queues) runs once is that action's question.
- `useProjectAssistant` and `projectPrepareBody`
  (`components/project-assistant/use-project-assistant.ts:113-122`) have no caller and send no
  `threadId`; they are deleted in PR 1 rather than adapted. The file itself stays: its
  `snapshotCanvas` and `snapshotView` are imported by `elench-conversation.tsx:22-25`. (Revision 3
  said the whole file had no caller; that was false.)

## 13. Decisions (maintainer delegation, 2026-10-08)

The maintainer delegated acceptance of this ADR on 2026-10-08. Each open question of revision 3 is
kept below as it was asked, followed by the decision and its reason. The rule for choosing: the
answer friendliest to the user (the SRE in the chat), unless it is unsafe; security, tenant
isolation and money correctness win ties. The design above already follows every decision.
**To veto one, name its Q number on #5548**; the sections named in it are the ones that change.

**Q1. Which org does a turn bill to and run in?** *Question:* pin the billing org on the thread at
its first turn, or bill each request to the org its tab names? Pinning has two consequences: a
thread pinned to an org with no AI plan or a spent budget is 402 from every tab, including tabs of
orgs that have budget; and a thread pinned to A driven from B's page runs A's tools and shows A's
data in B's grid.
**Decision: pin it** (§4.2, §6.1, C2). Continuations, Retries, regenerates and later turns bill to,
and run their tools in, the pinned org from any tab, and are refused `org-forbidden` once the caller
is no longer an active member. *Consequence, stated so it is a decision:* a member removed from the
pinned org is refused new turns but keeps reading the tool results already in their transcript and
the widgets pinned from them (§6.3); that is true on dev as well. *Reason:* one answer and its continuation can never land in two
ledgers, and a re-arm can never bill B for A's turn; the A-data-on-B's-page case reads only data the
caller is an active member of A for, in a thread only that caller can see.

**Q2. Where does the client's stale-transcript recovery ship?** *Question:* put the minimum
recovery into PR 1, or make ADR 0001's PR 2 a hard prerequisite?
**Decision: in PR 1** (§9.3, §10 item 8; slice 6). On every typed refusal: load the transcript
(refreshing `revisionRef`), clear the error, put uncommitted text back in the composer. *Reason:*
without it `transcript-stale` is a dead end between the PRs, and the cost is small because it reuses
`loadInto` and `restore`; waiting on ADR 0001's whole store would hold the billing fix hostage.

**Q3. What happens to an edited re-send of a stored turn?** *Question:* refuse it and keep the
edit, or answer the edit in place of the stored turn?
**Decision: refuse `turn-committed-different-text`; the draft is released with the edit and a
fresh turn id, never consumed** (§5.2, §9.3, §9.4 change 1). *Reason:* "typed text is never lost"
(ADR 0001) wins, and no stored user message is ever rewritten.

**Q4. Does deleting a thread abort its in-flight model call?** *Question:* let the answer finish
into the Recovered thread, or abort on delete?
**Decision: do not abort** (C5, §5.3). The full answer lands in the Recovered thread, billed once,
bounded by `TURN_BUDGET_MS`. *Reason:* it is dev's behaviour today, and an aborted answer would bill
at least the reserve (Q8) for a partial the user then has to regenerate.

**Q5. How many sweeps own stranded holds?** *Question:* extend `release-ai-holds`, or add a second
(say one-minute) sweep for claims?
**Decision: one sweep, `release-ai-holds`, extended** with the C8 pass, the claimed-hold exclusion
and retention, at its 15-minute interval (§8.2). *Reason:* one owner of the release rule; the next
accept on the thread expires a silent claim at once, so the 17.5-minute worst case only applies to
a thread nobody opens, where it costs headroom, not money.

**Q6. Which files may this work touch?** *Question:* widen #5515's `scope:`?
**Decision: yes.** The design PR's own file is `docs/adr/0003-*.md` (the issue names `0002-*.md`,
which went to ADR 0002, #5511). The build's globs are the union of the slices' in §14, which
replaces the proposal in the 2026-10-06 issue comment; the orchestrator edits the issue.
*Reason:* the defect lives in the schema, billing, authz, the reconcile loop and the client; a
scope that names only the routes cannot fix it.

**Q7. How long may a turn run?** *Question:* the value of `TURN_BUDGET_MS`.
**Decision: `900_000` (15 minutes)** (§8.2). *Reason:* above the measured six-minute deep-reasoning
turn, so no real turn is cut; a dead process's claim is released by the 90 s lease, not by this
bound.

**Q8. What does a partial answer cost?** *Question:* bill an answer that was cut by an abort,
a disconnect or the timeout at the completed steps' cost only, or with a floor?
**Decision: completed steps at real cost, and at least the 100-credit reserve, when any model
output was stored** (§8.1). Stop before any model output stays free. *Reason:* today a reader can
take a full one-step answer for 0 by disconnecting; the floor is at most about $0.10 against an
early Stop, and the user keeps the partial answer.

**Q9. What happens to a crashed attempt's hold?** *Question:* keep releasing it to 0 (as dev
does after 60 to 75 minutes, #2683, #3177), or keep the reserve as the price of an unknown cost?
**Decision: release to 0, sooner** (C8, at the next accept or within about 17.5 minutes). *Reason:*
"billed if and only if an answer is stored" holds without exception, and it keeps #2683's ruling.

**Q10. How long are terminal claims kept?** *Question:* the retention of `answered`, `failed` and
`expired` claims.
**Decision: 30 days** (§8.2 pass 3), counted from `finished_at`, also for a deleted thread's
claims: revision 5 removed the cascade, because a claim must outlive the delete for its token check
to decide which attempt finalizes (§4.3). *Reason:*
they hold no text, and 30 days covers any billing dispute window the ledger itself does not.

**Q11. Do the support and agent-identity routes move onto the claim?** *Question:* include
`/api/support/ask` and `/api/agent/[agentId]` in the build?
**Decision: yes, in their own slice after the Elench routes** (§14, slice 8), not inside the Elench
cut-over. *Reason:* they have the same four defects, and the claim gives their holds a claim-owned
release instead of §8.2's age assumption; a separate slice keeps the Elench cut-over reviewable.
`[agentId]` has no console caller, so Slice 8 first checks `apps/cli` and `apps/docs` for callers of
the route and lists any it finds in its PR. **Revision 5 narrows it:** the support route moves for a
request that names a thread; the console's support chat names none, so it keeps today's path, and
giving it threads is a follow-up (§12). A missing support thread is `thread-not-found`, never
recreated (§5.1 step 2). The floor of Q8 for a support turn is the hold its kind reserved, which is
`METERED_RESERVE_CREDITS` for every metered kind (`ai-guard.ts:382`).

### Decision log: review findings

- Revision 1's four blockers and revision 2's one blocker are fixed (revisions 2 and 3); revision 2's
  review confirmed B1-B4 fixed and revision 3 took A1-A17 of that review. None was rejected.
- One revision-1 advisory (A4: read the plan before the lock) was taken in a different form: the
  plan is read on `tx` after the lock (§5.1 step 7), because a read before the lock is a read on a
  second pooled connection, the deadlock `ai-guard.ts:308-311` warns against. The revision-2 review
  accepted this.
- Revision 4 corrected six statements about the code that were false at origin/dev:
  `Dockerfile:87` (the `CMD` is at `:93`); `deploy-console.yml:1316` (the `up -d` is at `:1363`); "`use-project-assistant.ts` has no caller" (its
  snapshot helpers do, §12); "`propose_operation` alone" (true for the Elench routes only, §3);
  the project route's `refId` (`threadId ?? projectId`, §1); and the in-transaction settle, which
  needed `recordAiUsage` to take `tx` as well (§5.3, §10 item 3). It also replaced an alert that the
  repo has no surface for with a stable log event plus a hand-off item (§8.1), required a
  non-empty pending set for the continuation Retry (§9.1), and named the `onRegenerate` signature
  change (§9.1).
- **Against ADR 0001** (#5512, revision 7.1): its §5.3 names the turn claim's key `(thread id, turn
  id, attempt key)`, as this ADR does. Revisions 6 and 7 carry §9.4's four changes; §9.4 names the
  slices that gate slices 6 and 9 here. Its `claim_turn_id` is a `uuid`, which `turn_id`'s zod rule
  (§4.1) accepts. (Revision 4 of this ADR still described ADR 0001 revision 5.1 and gated on "ADR
  0001's PR 1/PR 2", which revision 6 no longer has.)
- **Revision 5** answered the independent review of revision 4 (#5548: five inline blockers, nine
  advisories); its header lists what changed for each. One fact about the code was false and is
  corrected: the `[org]` layout does **not** pass an org id to the Elench store
  (`layout.tsx:36-56` uses it for `orgHasSelfRunners` only), and its `resolveOrgScope` id is the
  wrong one in community (§6.1). The pending-client-tool set is now taken from the approval's step,
  not the last step (§3), which revision 4's Retry rule silently depended on. No advisory was
  rejected.
- **Revision 5.1** answered the delta review of revision 5 (#5548: two inline blockers, seven
  advisories) and the slice-2 builder's finding. Blocker 1 (a stale cell target after slice 9): no
  send reads `pendingCellTarget` any more, and slice 9 deletes the slot (§9.2). Blocker 2 (slice 6's
  store check had no store): the check and its test moved to ADR 0001's slice 9 (§9.3, §14).
  Advisories 1-7 were all taken: C4r names the columns it clears; decision 6 says a resumed tail
  stays billed; a stale-revision resume keeps its Retry (§9.1); the recreate runs C8 first (§5.1
  step 2); the stream's `onError` is a C7 path (§5.3); a partial tail with a new proposal says to
  approve or reject it (§9.1); and §8.2 names the three `maxDuration` exports correctly. One fact
  about the code was false: §3's "`propose_operation` alone" on the Elench routes. The project
  assistant route's tool set has `propose_changes` with no `execute` (`compose.ts:230-236`). It is
  now a client tool, with an output schema, and is not an accepted approval (§3, §5.1 step 8,
  §5.2). Rejected: none.

## 14. Implementation slices

Paths in the prose are relative to `apps/console/`; the *Scope* globs are repo-relative, as an
issue's `scope:` line needs them. Slices are numbered, never "S<n>": S3, S4 and S5 are ADR 0001's
transitions, and ADR 0001's slices are written "0001/<n>". Slices 1-4 touch disjoint files and run
in parallel. Only Slice 1 has a migration, so only Slice 1 holds `mutex:migration`
(`.claude/skills/db-pipeline/SKILL.md`: rebase first, generate in one worktree). Each slice is sized
to about 800 changed lines or fewer, tests excluded where noted. Every existing test a slice breaks
is in that slice's scope, and every test is red on its slice's base, as §11 defines "fails on dev".
"PR 1" and "PR 2" in §10 are the two phases these slices cut up: Slices 1-8 are PR 1, Slice 9 is
PR 2. **Cross-ADR order** (stated identically in ADR 0001 §5.3 and §14): 0001/1 after Slice 1;
0001/4 after Slices 2 and 4; Slice 6 after 0001/4 and 0001/7b; 0001/9 after Slice 6; Slice 9 after
0001/7b and 0001/9.

| # | Title | Scope (under `apps/console/`) | Blocked by | Migration | Security review |
|---|---|---|---|---|---|
| 1 | Schema, migration and RLS | `lib/db/schema/agent.ts`, `lib/db/programmables.sql`, `lib/db/migrations/**`, `app/server/actions/agent.ts`, `tests/integration/agent-turn-claims-schema.test.ts`, `tests/actions/agent.test.ts` | — (0001/1 waits for it) | **yes** | **yes** (a new RLS policy) |
| 2 | The turn key and the client-tool list | `lib/agent/turn-key.ts`, `lib/ai/client-tools.ts`, `tests/lib/agent/turn-key.test.ts` | — (0001/4 waits for it) | no | no |
| 3 | Billing on one transaction | `lib/billing/ai-guard.ts`, `lib/billing/ai-plan.ts`, `lib/billing/queries.ts`, `lib/billing/ai-quota.ts`, `lib/billing/agent-metering.ts`, `tests/lib/billing/**`, `tests/integration/ai-hold-tx.test.ts`, `tests/integration/ai-guard-race.test.ts` | — | no | **yes** (billing) |
| 4 | The named-org resolver | `lib/authz/guard.ts`, `tests/api/agent-turn-org.test.ts`, `tests/lib/authz/guard.test.ts` | — (0001/4 waits for it) | no | **yes** (authz seam 2) |
| 5 | The claim state machine | `lib/agent/turn-claims.ts`, `lib/agent/transcript-save.ts`, `lib/agent/thread-transcript.ts`, `tests/lib/agent/turn-claims.test.ts`, `tests/integration/agent-turn-claims.test.ts`, `tests/lib/agent/transcript-save.test.ts`, `tests/lib/agent/thread-transcript.test.ts` | 1, 2, 3 | no (uses Slice 1's) | **yes** (service-role statements with explicit owner predicates, billing) |
| 6 | The Elench cut-over: routes, transport and the minimum recovery | `app/api/agent/route.ts`, `app/api/projects/[projectId]/assistant/route.ts`, `lib/agent/turn-route.ts`, `components/agent/use-agent-chat.ts`, `components/agent/agent-chat.tsx`, `components/agent/elench/elench-conversation.tsx`, `components/agent/approval-card.tsx`, `components/support/ask/support-case-approval-card.tsx`, `components/agent/render-tool-parts/project-tool-parts.tsx`, `components/project-assistant/use-project-assistant.ts`, `app/(private)/[org]/layout.tsx`, `components/shell/app-shell.tsx`, `lib/stores/use-elench-store.ts`, `tests/api/agent-turn-routes.test.ts`, `tests/components/agent-turn-refusal.test.tsx`, `tests/api/agent-message-limit.test.ts`, `tests/api/projects/assistant-route-env.test.ts`, `tests/components/elench-conversation-retry.test.tsx`, `tests/components/agent-chat-parts.test.tsx` | 4, 5, **0001/4**, **0001/7b** | no | **yes** (route org and project gates, seam 2) |
| 7 | The sweep | `lib/reconcile/ai-holds.ts`, `tests/integration/ai-hold-sweep.test.ts`, `tests/lib/reconcile/ai-holds.test.ts` | 5 (parallel with 6) | no | **yes** (money release) |
| 8 | The support and agent-identity routes (Q11), and the `mcp` route's `maxDuration` | `app/api/support/ask/route.ts`, `app/api/agent/[agentId]/route.ts`, `app/api/mcp/route.ts`, `lib/agent/turn-route.ts` (amended 2026-10-09, below; planned as a new `lib/agent/turn-route-support.ts`), `tests/api/support-turn-routes.test.ts` | 6 (planned to import slice 6's `turn-route.ts` and never edit it; it edited it, amended 2026-10-09, below) | no | **yes** (route org gates) |
| 9 | The client half on ADR 0001's store (PR 2) | `components/agent/use-agent-chat.ts`, `components/agent/elench/elench-conversation.tsx`, `components/agent/elench/use-elench-send.ts`, `lib/stores/use-elench-store.ts`, `lib/stores/use-widget-grid-store.ts`, `lib/stores/elench-drafts/reducer-sending.ts`, `lib/agent/turn-route.ts`, `app/api/agent/route.ts`, `app/api/projects/[projectId]/assistant/route.ts`, `tests/components/agent-turn-refusal.test.tsx`, `tests/components/widgets/cell-prompt.test.tsx`, `tests/api/agent-turn-routes.test.ts`, `tests/lib/stores/elench-drafts-sending.test.ts` | 6, **0001/7b**, **0001/9** (and 9b, if it splits) | no | no |

**Amended 2026-10-09 (after #5825, by maintainer delegation).** Slice 8 did not add
`lib/agent/turn-route-support.ts`. It extended the shared helper `lib/agent/turn-route.ts` instead:
`TurnRouteSpec` gained `threadKind`, `aiKind` (both default `agent`) and an optional `gate`, the
route's own check, and the support and agent-identity routes call `serveTurnBody`, the body the
two Elench routes reach through `serveTurn`. One stream half serves all four routes, so they cannot
drift on who pays, whether the model runs, or what is stored. The row above therefore names
`turn-route.ts` and no longer says slice 8 never edits it; slice 9's scope is unchanged. Recorded
under the maintainer's delegation of this ADR (§13), by #5834.

**Slice 1. Schema, migration and RLS.** *Done when:* `agent_turn_claims` (§4.1: every column,
`accepted_at` included, `thread_id` with **no** foreign key, both unique constraints, the three
partial indexes, the check), `agent_threads.revision` and `agent_threads.billing_org_id` (§4.2) are
in the schema and one generated migration; `programmables.sql` `ENABLE`s RLS on the table and
carries the `owner_only` policy (§4.3); `getThread` returns `revision` and `inFlight` (silent
leases excluded); `createThread` bumps `revision`, returns it, and does nothing while a claim runs;
the `agent.ts:119-123` comment cites the 15-minute turn bound plus the 90 s lease (§8.2); and the I
tests for the constraints, RLS enabled, the policy, the claim on another user's thread id, and
`getThread` pass, with `tests/actions/agent.test.ts` updated for `createThread`'s return. It lands
before 0001/1, which rebases over its schema and migration.

**Slice 2. The turn key and the client-tool list.** *Done when:* `lib/agent/turn-key.ts` exports
`turnText` (§5.2's one definition, the one ADR 0001 imports), `pendingClientToolCalls` (§3: the
approval's step, not the last step), `hasAcceptedApproval` (§5.2) and the pure classifier of §5.2
(`classifyTurn`, the whole table: the continuation-only rule, the different-text-first order, the
accepted-approval refusal, the resume, the `invalid` row, a Retry through the submit rows
including the append of a turn that was never stored), and `lib/ai/client-tools.ts` exports
`CLIENT_TOOL_NAMES` (`propose_operation`, `create_support_case`, `propose_changes`) and their
output schemas with the 4,096-byte cap (§5.1 step 8), with U tests: the names equal the tools
without `execute` in **all three** tool sets the routes build (`buildAgentTools`,
`buildProjectAgentTools`, `buildSupportTools`); `hasAcceptedApproval` reads only `status`, and an
accepted `propose_changes` is not an accepted approval; `turnText`'s trim and line-ending pairs; the pending set of a
continued answer is the approval's step. No route imports them yet.

**Slice 3. Billing on one transaction.** *Done when:* `reserveAiHold(tx, orgId, kind, userId)` is
extracted from `assertAiAllowed`, which keeps its signature and behaviour for every other caller and
calls it; `resolveAiPlan` and `getOrgBilling` (`lib/billing/queries.ts`) take an optional `tx`;
`recordAiUsage` and `recordAgentTurnUsage` take an optional `tx`, and run their side effects
(`captureAiGeneration`, `checkAiSpendThreshold`) only after the caller's commit when a `tx` is
given; `recordAgentTurnUsage` takes `floorCredits` and applies it to the **sum** of the attempt's
rows by raising row 0 (§8.1); the budget refusal is still built and thrown outside the transaction.
The existing tests under `tests/lib/billing/` (`ai-guard.test.ts`, `agent-metering.test.ts`,
`ai-plan.test.ts`, `ai-quota-settle.test.ts`) and `tests/integration/ai-guard-race.test.ts` stay
green or are updated in this slice; new tests cover the `tx` path, the floor against a multi-row
attempt and the deferred side effects.

**Slice 4. The named-org resolver.** *Done when:* `resolveTurnActor(userId, orgId)` (§6.1) is in
`lib/authz/guard.ts`, quiet (`can`, no activity row), strictly two-way with the personal arm, and
the O tests (community `orgId = userId`; enterprise suspended member is refused, not landed on the
personal org; no session fallback) pass, with `tests/lib/authz/guard.test.ts` still green. 0001/4's
heartbeat route uses it.

**Slice 5. The claim state machine.** *Done when:* `lib/agent/turn-claims.ts` exports `reserveTurn`
(§5.1, all nine steps, one connection, the lock order, the recreate rule with its claim cleanup and
the support rule, the output schemas), `heartbeatTurn` (C5 with its age guard), `finalizeTurn`
(§5.3: its four outcomes with `deleted` taken only by the compare-and-set winner, C7 for a throw
before the stream, steps from `onStepFinish`, settle or release on `tx`, side effects after commit,
the `finalize-metering-failed` log event) and `expireSilentTurns` (C8, lease or age), plus
`TURN_BUDGET_MS`; `transcript-save.ts`/`thread-transcript.ts` gain `appendLive` and `replaceLast`
(which also replaces a resumed answer's tail) and keep the recover branch; the U transition tests,
the I tests of §11 (lock order, one connection, 402 rollback, settle-in-finalize, C8 at accept, the
delete sequence of case 18) and the T tests pass, with the existing `thread-transcript.test.ts` and
`transcript-save.test.ts` updated. No route calls it yet. *Hand-off:* the maintainer configures a
log alert on `finalize-metering-failed` (§8.1).

**Slice 6. The Elench cut-over: routes, transport and the minimum recovery.** *Done when:* both
Elench routes refuse in §9.3's order, require `orgId` and `turn` (409 `client-outdated` otherwise),
resolve the actor with `resolveTurnActor` and the thread's pin, check the project (§6.2), run inside
`runWithActor`, accept through `reserveTurn`, build the model input from the stored transcript,
finalize before `finish` (and as C7 from the pre-stream `catch`), heartbeat from stream registration
until finalize, bound themselves with `TURN_BUDGET_MS`, answer typed refusals, and export no
`maxDuration`; the `[org]` layout passes `currentActor().orgId` to `AppShell`, which keeps it for the
transport's `orgRef`; the transport sends §9.1's fields to opted-in callers only and returns
`setBaseRevision`; Regenerate is not rendered on an answer with an accepted approval and Retry
follows §9.1, including the stale-revision resume that keeps its card and the partial tail with a
new proposal that offers no Retry; `onTurnRefused` (§9.3) ships with its **composer path only** (the
one-handler store check and its `One refusal handler` test are ADR 0001 slice 9's, which waits for
this slice); the three approval cards truncate their free text to fit the output schemas (§5.1 step
8); the request schema validates `orgId` with `z.uuid()` **before** `resolveTurnActor` is called (the
enterprise resolver casts it `::uuid`, so a malformed id would throw a 500 instead of answering 403),
and `userId` is taken **only** from the verified session, never from the body (#5720 review);
`useProjectAssistant` and `projectPrepareBody` are deleted; every R and C test of §11 that is not
marked PR 2 or ADR 0001 slice 9 passes (the route-level org and project tests of cases 3 and 4 and the community
team-org test included), and the existing `agent-message-limit.test.ts`,
`assistant-route-env.test.ts`, `elench-conversation-retry.test.tsx` and `agent-chat-parts.test.tsx`
are green or updated here. The shared route body lives in one helper so the two routes stay thin.
This is the largest slice; if it exceeds about 800 lines without tests, the C half (transport,
Retry, `onTurnRefused`, the layout and shell) splits into Slice 6b, which must merge in the same
deploy window, never after.

**Slice 7. The sweep.** *Done when:* `release-ai-holds` runs the three passes of §8.2 (C8 for claims
silent or past their age bound, through `expireSilentTurns`; the age pass excluding any hold a
running claim names; 30-day retention from `finished_at`, deleted threads included), the
`ai-holds.ts:27-37` comment says what §8.2 says and drops "books the cost twice", and the I tests
(sweep expires a silent claim and an over-age one; the age pass skips a claimed hold; retention
removes a deleted thread's claims after 30 days) pass, with `tests/lib/reconcile/ai-holds.test.ts`
updated.

**Slice 8. The support and agent-identity routes (Q11), and the `mcp` export.** *Done when:*
`/api/agent/[agentId]`, and `/api/support/ask` for a request that names a thread, accept through
`reserveTurn` with their own kind and project, resolve the org with `resolveTurnActor`, finalize
before `finish`, and answer typed refusals; a support request with no `threadId` keeps today's path
unchanged (§12); a missing support thread is `thread-not-found`; the `maxDuration` exports of
`[agentId]/route.ts` and `app/api/mcp/route.ts:19` are deleted; R tests cover a duplicated threaded
support turn (one hold), an approved support-case card continuation, and an unchanged threadless
support turn. The support chat's components are not changed.

**Slice 9. The client half on ADR 0001's store (PR 2).** *Done when:* `onTurnRefused` dispatches to
the store only (D9d's and D10f's arms, D20) and its composer path is deleted; "Being answered" polls
`getThread.inFlight`; `body.mentions`, `body.cellTarget` and the `pendingMentions` slot are deleted
and the routes read the stored message's metadata only, which removes D9b's staging of the slot
(`reducer-sending.ts`, `use-elench-send.ts`, both in scope); `takePendingCellTarget`, and
`pendingCellTarget` / `setPendingCellTarget` in `use-widget-grid-store.ts`, are deleted (ADR 0001
slice 9 already stopped writing the slot, §9.2), with `cell-prompt.test.tsx`'s store reset updated;
C › `after a cell prompt, the next composer turn's stored message has no cellTarget` passes; the PR 2 tests of §11 pass, the empty-cell
prompt test of §9.2 included.
