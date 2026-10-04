<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Elench drafts: server-side rows keyed by (user, org id, conversation), saved by compare-and-set

**Status:** proposed (2026-10-04, revision 3) · **Issue:** #5464 · **Supersedes:** revision 2 of this
ADR (833e4e9c4, a client-only `sessionStorage` store) and the draft store reverted from #5423 (head
2c1314267)

**Maintainer ruling (2026-10-04): server-side drafts.** Unsent drafts and failed first turns live in
the database. They are keyed by (user id, org id, conversation id), never by an org slug. They are
autosaved with a monotonic revision (compare-and-set) and can be read from any tab or device.
`sessionStorage` is at most a cache. This revision rewrites the design around that ruling. It
replaces revision 2's §6 ("Why not server-side drafts"), which argued for the opposite.

**Decision (proposed).**

1. **One row per unsent message.** A new table, `elench_drafts`, holds at most one row per
   `(user_id, org_id, conversation_id)`. `org_id` is the id the server resolved for the request
   (`currentActor().orgId`), never a slug. The row holds the composer's editor state, its text and
   mentions, any pending artifact placements, and an optional **failed-start marker**. Its RLS
   policy requires **both** `user_id = app.current_owner` **and** `org_id = app.current_org`.
   A teammate in the same org can never read it.
2. **Every write is a compare-and-set on `revision`.** The client sends the revision it last saw. A
   write against an older revision changes nothing and returns the current row. No path overwrites
   words that the writer has not seen.
3. **A first send is one transaction.** `startConversation` locks the draft row and checks its
   revision. It then inserts the thread under the client-minted conversation id, with the
   first turn, and clears the draft. All of this happens in one transaction. The failed first turn is
   therefore never a second copy of the words. Either the transaction committed, and the words are
   the thread's first message, or it did not, and the words are still the draft row.
4. **No turn is answered twice.** Each chat route claims `(thread id, user-message id)` in a new
   `agent_turn_claims` table **before** it reserves the AI budget hold. A second request for the
   same turn, from any tab, device or retry, gets a 409 and reserves nothing.
5. **The client is a cache and a save queue.** It keeps unsaved edits in memory, and in
   `sessionStorage` **only until the server acknowledges them**. It reports truthfully whether the
   words on screen are saved to the account, and resolves conflicts in the open.

**Why.** #5423 grew a client draft store over eight review rounds. Revision 2 removed three classes
of its failures: a key that changes, two editable copies, and a snapshot that diverges from memory.
The 21 gaps found on this PR show that revision 2 then accumulated a fourth class: **a
client-side guess about server state** (`checked`, `realmId`, `rev` bumps, rule P, the `rewritten`
outcome). Server-side rows with compare-and-set remove that class. The server decides every
question about shared state, in one transaction, and returns the row. §11 shows, case by case,
what is eliminated and what still needs a transition and a test.

| Class | Gaps it produced | Removed by |
|---|---|---|
| A key that changes under the words | #5423: 4173571375, 4173571377, 4174362779, 4174713084, 4174713086; #5512: G17 | The key is `(user, org id, conversation id)`, and the conversation id is the thread id from birth (I2) |
| Two copies of one message | #5423: 4173297525, 4173404109; #5512: G2, G4, G20 | At submit the words **move** from the draft into the first turn, in one transaction (I1). There is no snapshot and no rule P. |
| Storage that diverges from the truth | #5423: 4174550045, 4174130695; #5512: G7, G8, G19 | The server row is the truth. The cache holds only unacknowledged edits and is removed on acknowledgement (I4). |
| A client guess about server state | #5512: G1, G3, G13, G14, G15, G16, G18, G21 | Compare-and-set outcomes, the start-outcome table, and turn claims. The client never infers. |
| A turn billed twice | #5423: 4173024467; #5512: G1, G18 | `agent_turn_claims` before the budget hold (I7) |

---

## 1. Context: what the code does today (origin/dev @ fbe2409c8)

Every statement was read from the tree at fbe2409c8, the current `origin/dev`. Revision 2's §1
claims were re-verified by the second review at the same commit and are kept where they still matter.

**The composer and the send path (unchanged from revision 2).**
- The draft is the composer's own Lexical state. `ElenchComposer` reads `seed` once at mount
  (`apps/console/components/agent/elench/elench-composer.tsx:67-77`). It clears the editor after a
  send only when the editor still holds exactly the sent text (`elench-composer.tsx:188-193`).
  Anything that unmounts the composer drops the words.
- Five things unmount the composer: a modal/panel flip (`elench-conversation.tsx:502-531`), the
  landing giving way to the docked transcript (`elench-empty-landing.tsx:116-122`,
  `elench-conversation.tsx:440`), close (`elench-surface.tsx:21`), a lineage change (epoch-keyed
  boundary, `elench-conversation.tsx:435`; `use-elench-store.ts:209-248`, `:264-272`), and reload.
- A failed first send is component state (`use-elench-send.ts:72-78`), reset on every lineage
  change (`elench-conversation.tsx:270-273`).
- Mentions travel through a global store slot. `beforeSend` stages them in the slot
  (`elench-conversation.tsx:244-255`), and `prepareBody` reads it (`:158-195`).
- **The per-call `body` of `sendMessage` never reaches the route.** `useAgentChat` returns its own
  `body` from `prepareSendMessagesRequest: ({ messages }) => ({ body: { messages, ...prepareBody } })`
  (`apps/console/components/agent/use-agent-chat.ts:60-64`). The transport sends a returned `body`
  as it is. It merges `options.body` only into the callback's argument
  (`node_modules/.pnpm/ai@6.0.279_zod@4.5.4/node_modules/ai/dist/index.mjs:14150-14171`). The same
  callback also drops `trigger` and `messageId`, which the transport passes in (`:14158-14159`).
- Reopen resumes `resumeIdRef.current ?? list[0]` (`use-elench-threads.ts:83`). Neither
  `listThreads` (`:80`) nor the `getThread` inside `loadInto` (`:51`, awaited at `:84`) has a
  `catch`. A rejection leaves the body on its skeleton.
- `loadInto` is the only thing that puts a stored transcript into `useChat` (`use-elench-threads.ts:49-55`).
  The "No reply arrived" state needs `messages.length === initialMessages.length` with a trailing
  user turn (`elench-conversation.tsx:223-229`).
- Regenerate is a real feature on answered turns (`elench-conversation.tsx:464`,
  `components/agent/agent-chat.tsx:326`), as well as the Retry of an unanswered one (`:302`).

**Threads, billing and tenancy.**
- `agent_threads` (`apps/console/lib/db/schema/agent.ts:21-45`) has a server-minted id
  (`:24`, `uuid().primaryKey().defaultRandom()`). `createThread` is idempotent through a
  read-then-insert on `messages->0->>'id'`, and rewrites the turn while the row holds one message
  (`app/server/actions/agent.ts:56-105`; lookup `:67-90`). The lookup ignores `project_id`.
- `createThread` writes `org_id: owner` (`agent.ts:97`), and every thread action runs under
  `withOwnerScope` (`agent.ts:66`, `:127`, `:164`, `:197`), which sets both RLS variables to the
  user (`lib/db/index.ts:93-98`). Org-level threads are user-scoped, so one thread is listed in
  every org.
- `listThreads` reaps zero-message rows older than an hour and tombstones older than a day
  (`agent.ts:128-143`). `getThread` returns null for a tombstone and for a missing row alike
  (`agent.ts:162-172`). `deleteThread` deletes the row (cascading widgets and feedback) and
  writes a tombstone (`agent.ts:195-217`).
- The chat routes save the client's transcript wholesale. The stream uses `originalMessages:
  messages` from the request (`app/api/agent/route.ts:282`), and `onFinish` saves the finished
  list (`route.ts:376-383`) through `updateLive`, which replaces the whole list
  (`lib/agent/transcript-save.ts:121`).
- **The budget hold has no per-turn identity.** `/api/agent` reserves it with
  `assertAiAllowed(actor.orgId, "agent", actor.userId)` (`route.ts:201`). Its `refId` is the
  thread id (`route.ts:220-225`), so two requests for the same turn reserve and spend twice.
  `onAbort` releases the hold on a client disconnect (`route.ts:370-372`).
- The project assistant declares `maxDuration = 300` (`app/api/projects/[projectId]/assistant/route.ts:51`).
  `app/api/agent/route.ts` declares none. Only `app/api/agent/[agentId]/route.ts:33` does.
- **The tenant of a chat turn is the session's org**, which every tab shares. Both routes call
  `currentActor()` (`route.ts:171`; `assistant/route.ts:181`). That prefers the org in the URL and
  falls back to `active_organization_id` where the address names none, which includes `/api/**`
  (`lib/authz/guard.ts:27-38`; `lib/authz/org-scope.ts:24-25`). `switchOrg` writes the session
  value (`lib/stores/use-workspace-store.ts:50-53`).
- **A server action's tenant is the page's org.** The proxy publishes the request path on
  `x-alethia-path`. A server action is a POST to the page's own path, and a forwarded action keeps
  the first pass's value (`lib/authz/org-path.ts:16-21`). So `currentActor()` inside an action
  invoked from `/acme/…` resolves `acme`, and an action invoked from a page whose slug no longer
  resolves throws (`org-scope.ts:27-30`).
- **In community every org slug resolves to the personal scope.** `getActiveScope` ignores its org
  argument without the enterprise resolver and answers `orgId === userId` (`lib/auth/scope.ts:20-31`).
  `currentActor()` accepts that collapse as its second arm (`guard.ts:50-65`).
  `resolveNamedOrgScope` is strictly two-way and refuses it (`guard.ts:154-160`, comment `:59-64`).
- `authorize()` records activity through `enforce()`. `authorizeQuiet()` uses `can()` and records
  nothing (`guard.ts:96-122`).

**RLS.**
- `owner_all` on `agent_threads` and nine other tables is an **OR**: `user_id = app.current_owner
  OR org_id = app.current_org` (`lib/db/programmables.sql:1117-1137`). On a table whose `org_id`
  is a real org, any member of that org passes the second arm.
- `kubeconfig_mint_requests` is the precedent for a row that is its requester's alone. Its policy is
  an **AND** of the org and the actor (`programmables.sql:1160-1176`).
- `withScope` sets both variables per transaction (`lib/db/index.ts:72-82`). `withActorScope` sets
  them to the actor's user and resolved org (`:108-113`).

**Retention and erasure hosts.**
- The erasure register erases `agent_threads` by `user_id` (`lib/privacy/erasure-plan.ts:118-127`).
  `tests/privacy/erasure-register-schema.test.ts` checks every table and column it names against
  the schema.
- Time-based sweeps run on the supervised reconcile loop, for example `kubeconfig-mint-sweep`
  (`lib/reconcile/loop.ts:52`, `:130-131`; `lib/kubeconfig-mint/sweep.ts:1-22`).
- RLS policies are tested against the real policy with `describeIfDb`
  (`tests/integration/db.ts:61`; pattern: `tests/integration/support-rls.test.ts`).
- Next's server-action body limit is not configured (`next.config.ts:65` sets only
  `allowedOrigins`), so the default of 1 MB applies.

## 2. Vocabulary

- **Conversation**: one thing on screen that can hold a transcript. Its **conversation id** is a
  UUID that the client mints at New chat, at Open in new chat, or at first open. From the first
  send it is also the `agent_threads.id`.
- **Scope**: `(orgId, anchor)`, where `orgId` is the id the server resolved and `anchor` is `org` or
  `project:<id>`. The user is implicit, because every row and every cache item belongs to the
  signed-in user. A **key** is a scope plus a conversation id.
- **Draft**: the `elench_drafts` row for a key. Its **content** is `{ editor, text, mentions,
  artifacts }`.
- **Thread status** of a key, as `listDrafts` reports it from `agent_threads`:
  - `none`: there is no row.
  - `unlisted`: the row is live and has zero messages.
  - `listed`: the row is live and has messages.
  - `deleted`: there is a tombstone.

  The draft's `thread_seen` flag tells two kinds of `none` apart. If the flag is false, the
  conversation was never sent. If it is true, the thread existed once and has since been reaped.
- **Failed-start marker**: `{ turnId, error, at, cellTarget? }` on the draft. It records that a
  first send of this draft was attempted and did not commit. It holds no text, because the text is
  the draft's content.
- **Acknowledged**: the server returned a revision for exactly the content on screen.
- **Unsaved**: memory holds content that no server revision acknowledges.

## 3. Data model

### 3.1 `elench_drafts`

In `apps/console/lib/db/schema/agent.ts`, beside `agentThreads`:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, `defaultRandom()` | row id. It is never shown and never sent by the client. |
| `user_id` | `uuid` not null | the session user (`currentActor().userId`) |
| `org_id` | `uuid` not null | `currentActor().orgId`. In community this is the user id, which is the one tenant (§1). |
| `project_id` | `uuid` null | the anchor. Null is org-level. It is immutable after insert. |
| `conversation_id` | `uuid` not null | the thread id, from birth |
| `revision` | `integer` not null | starts at 1 on insert. Each successful write adds one. |
| `status` | `text` not null, `'active' \| 'discarded'` | a discard is soft (§6.2) |
| `discarded_at` | `timestamptz` null | set with `status = 'discarded'` |
| `editor` | `jsonb` `$type<ElenchDraftEditor>()` not null | Lexical serialized state |
| `text` | `text` not null | plain text derived on the client. The server checks it against the editor (§4.1). |
| `mentions` | `jsonb` `$type<ElenchDraftMention[]>()` not null default `[]` | |
| `artifacts` | `jsonb` `$type<string[]>()` not null default `[]` | pending Open-in-new-chat placements |
| `failed_start` | `jsonb` `$type<ElenchFailedStart>()` null | the marker (§2) |
| `thread_seen` | `boolean` not null default false | set when the thread is known to have existed |
| `title` | `text` null | last known thread title, for the Unsent label |
| `last_writer` | `text` null | an opaque tab id, used only to word a conflict ("another tab" or "this tab") |
| `created_at`, `updated_at` | `timestamptz` | `updated_at` drives retention |

Constraints and indexes:
- `unique (user_id, org_id, conversation_id)`: the key.
- `index (user_id, org_id, project_id, updated_at desc)`: for `listDrafts`.
- `index (updated_at)` and `index (discarded_at)`: for the sweep.
- `check (status = 'discarded') = (discarded_at is not null)`.
- `check (octet_length(text) <= 400000)`: 100,000 characters (`MAX_USER_MESSAGE_CHARS`,
  `lib/ai/message-limits.ts:20`) at the UTF-8 worst case. zod enforces the character limit first
  (§4.1).

The JSONB interfaces `ElenchDraftEditor`, `ElenchDraftMention` and `ElenchFailedStart` go in
`apps/console/types/jsonb.types.ts`, as CLAUDE.md §6 requires.

### 3.2 `agent_turn_claims`

| Column | Type | Notes |
|---|---|---|
| `thread_id` | `uuid` not null | |
| `turn_id` | `text` not null | the user message id (`firstTurnSchema.id` is a string, `agent.ts:22-23`) |
| `user_id`, `org_id` | `uuid` not null | `org_id` is the org the turn is billed to |
| `state` | `text` not null, `'running' \| 'answered' \| 'failed'` | |
| `answer_id` | `text` null | the assistant message id that answered the turn |
| `lease_until` | `timestamptz` not null | `now() + 330 s` at claim time (the 300 s duration plus a margin; see Q9) |
| `created_at`, `updated_at` | `timestamptz` | |

`primary key (thread_id, turn_id)`. Rows are removed with their thread (§8) and by the sweep 30 days
after `updated_at`.

### 3.3 RLS

Both tables get their **own** policy in `programmables.sql`, modelled on
`kubeconfig_mint_requests` (`:1167-1176`). They are deliberately **not** added to the `owner_all`
OR loop (`:1127`):

```sql
CREATE POLICY owner_only ON public.elench_drafts FOR ALL
  USING (user_id = current_setting('app.current_owner', true)::uuid
         AND org_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_owner', true)::uuid
         AND org_id = current_setting('app.current_org', true)::uuid);
-- the same for agent_turn_claims
```

Under the OR policy, any member of an org whose id is `app.current_org` would read every
member's drafts. Drafts may contain pasted secrets (§9), so this is the one table where that would
be a leak of the worst kind. Unset variables are NULL, and NULL denies.

One `SECURITY DEFINER` function crosses orgs, and only within the caller's own rows:

```sql
-- Purges the CURRENT OWNER's drafts of one conversation in every org (deleteThread, §6.3).
-- The owner comes from the GUC that withScope sets, never from an argument, so no caller can
-- point it at another user.
CREATE FUNCTION public.purge_elench_drafts_of_conversation(p_conversation uuid) RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH d AS (DELETE FROM public.elench_drafts
             WHERE user_id = current_setting('app.current_owner', true)::uuid
               AND conversation_id = p_conversation RETURNING 1)
  SELECT count(*)::int FROM d $$;
```

A companion `count_elench_drafts_of_conversation(p_conversation)`, with the same owner pin and
`SELECT` only, feeds the delete confirm. Both functions are `REVOKE`d from `PUBLIC` and granted to
the app role.

## 4. Server API

All actions go in a new `apps/console/app/server/actions/elench-drafts.ts` (`"use server"`). Every
action does the following:

1. It parses its input with a zod schema. The input never carries `user_id`, and no input field
   is trusted as a tenant.
2. It resolves `actor = await currentActor()`. For a server action, that is the page's org (§1).
3. It refuses with outcome `scope-changed` when `input.orgId !== actor.orgId`, and writes nothing.
   The client got `orgId` from `listDrafts`, so a mismatch means one of three things: the tab's
   slug now names another org, the slug was renamed, or the person signed in to the tab changed.
4. It authorizes **quietly**, because an autosave is not an activity-log event (`guard.ts:106-122`).
   For an org anchor it calls `authorizeQuiet("view", { type: "org" })`. For a project anchor it
   calls `authorizeQuiet("view", { type: "project", id })`, so a project draft needs the project
   to be visible in **this** org.
5. It runs in `withActorScope(actor, tx => …)` (`lib/db/index.ts:108-113`), so both RLS
   variables are the actor's. `agent_threads` rows still pass `owner_all` through
   `user_id = current_owner`.
6. It returns a discriminated union. It never throws for an expected outcome, and an
   `UnauthorizedError`/`ForbiddenError` becomes `{ outcome: "unauthorized" | "forbidden" }`.
   A database error throws, and the client counts it as transient.
7. It is rate limited per user with `checkRateLimit` (`lib/rate-limit.ts:62`) at 20 writes per
   second. A refusal is `{ outcome: "rate-limited" }`, which the client treats as transient.

### 4.1 Input schemas

```ts
const keySchema = z.object({
  orgId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  conversationId: z.string().uuid(),
});
const contentSchema = z.object({
  editor: elenchDraftEditorSchema,                       // structural Lexical root, depth- and node-capped
  text: z.string().max(MAX_USER_MESSAGE_CHARS),
  mentions: z.array(mentionSchema).max(50),
  artifacts: z.array(z.string().uuid()).max(10),
}).refine(c => serializedBytes(c) <= 900_000, "too-large");  // under Next's 1 MB action body
```

The server derives the plain text from `editor` and refuses a `text` that does not match
(`invalid`). The stored `text` is then never a second, independent copy.

### 4.2 Actions

| Action | Input | Effect | Outcomes |
|---|---|---|---|
| `listDrafts` | `{ projectId }` (the org is the page's) | Reads the active drafts of this scope, plus the discarded drafts of the last 24 h. It joins `agent_threads` by `conversation_id` (tombstones included) for each draft's thread status and title. | `{ outcome: "ok", orgId: actor.orgId, drafts }` |
| `saveDraft` | key, `baseRevision` (0 = none yet), content, `failedStart?`, `threadSeen?`, `tabId` | Locks the row `FOR UPDATE`. Inserts when `baseRevision = 0` and no row exists. Updates when `revision = baseRevision` and the row is active. Sets `failed_start` only when the input names one; `null` clears it. Sets `thread_seen` only when the server finds the thread row. | `saved(revision)` · `conflict(row)` · `discarded(row)` · `gone` (no row, and `baseRevision > 0`) · `limit` (§4.3) · `too-large` · `invalid` · `scope-changed` · `unauthorized` · `forbidden` · `rate-limited` |
| `discardDraft` | key, `baseRevision` | Sets `status = 'discarded'` and `discarded_at = now()`, and adds one to `revision`, when `revision = baseRevision`. **It never touches `agent_threads`.** | `discarded(revision)` · `conflict(row)` · `gone` |
| `restoreDraft` | key, `baseRevision` | Sets the row back to active when it is discarded at `baseRevision`. | `saved(revision)` · `conflict(row)` · `gone` |
| `startConversation` | key, `baseRevision`, `turnId`, `origin`, external text and mentions when `origin ≠ composer`, `cellTarget?`, `title` | §5 | §5 |
| `deleteThread` (changed) | `{ id }` | As today, plus `purge_elench_drafts_of_conversation(id)` in the same transaction (§6.3) | `{ purged }` |
| `countDraftsOfConversation` | `{ id }` | For the delete confirm | `{ count, orgs }` |

### 4.3 Bounds

`saveDraft` refuses a **new** row when the scope already holds 200 active drafts. That refusal is
`limit`. An existing row is never refused for the count, and nothing is ever evicted (I3). The
client keeps the words in the tab and says so (§7).

## 5. First send, failed first turn, idempotent retry, no double billing

### 5.1 `startConversation`

```
startConversation({ orgId, projectId, conversationId, baseRevision, turnId, origin,
                    text?, mentions?, cellTarget?, title })
```

The whole action is **one** `withActorScope` transaction:

1. `SELECT … FROM elench_drafts WHERE (user, org, conversation) FOR UPDATE`.
   - The row exists and `revision ≠ baseRevision`, or the row is discarded: return
     `draft-conflict(row, threadStatus)`. Nothing is written.
   - The row is absent and `baseRevision > 0`: return `draft-conflict(null, threadStatus)`.
   - Otherwise continue. When the row is absent and `baseRevision = 0`, the start is an external
     prompt that was never a draft.
2. Decide the first turn. For `origin = composer`, the text and mentions are **read from the locked
   row**, never taken from the input. The client flushed before it submitted, so the row at
   `baseRevision` is what the box showed. For an external origin they come from the input,
   validated by `contentSchema`.
3. `INSERT INTO agent_threads (id, user_id, org_id, project_id, title, messages) VALUES
   (conversationId, owner, owner, projectId, …, [{ id: turnId, role: "user", parts: [text],
   metadata: { mentions, cellTarget } }]) ON CONFLICT (id) DO NOTHING RETURNING id`.
4. The insert wrote the row, so the outcome is `created`. In the same transaction, the draft row is
   updated as follows:
   - for `origin = composer`, the content is emptied;
   - for an external start, the content is left unchanged;
   - `failed_start` is set to null, `thread_seen` to true, and `revision` goes up by one.
5. The insert wrote nothing. The server reads the conflicting row by id under the same scope,
   tombstones included, and returns exactly one outcome:

| The conflicting row | Outcome | Draft row |
|---|---|---|
| not visible under RLS (another owner's id) | `conflict` | unchanged |
| a tombstone | `deleted` | unchanged |
| `kind ≠ 'agent'`, `project_id` differs (null-safe), or zero messages | `conflict` | unchanged |
| first message id ≠ `turnId` | `conflict` | unchanged |
| first message id = `turnId` | `already-stored` | as for `created` (step 4) |

There is no `rewritten` outcome and no `realmId`. A stored first turn is never rewritten. A retry
with edited text goes through step 1. If the row had committed, the commit added one to the revision
and the retry's base is stale, so the edit becomes a `draft-conflict` the user resolves in the open
(§7, D17). If it had not committed, the edit is simply the draft content at the new base.

Mentions are stored on the first message's `metadata`, so a stored turn carries its own mentions
(advisory A3). From now on every turn carries its mentions on its own message: `sendMessage({ text,
metadata: { mentions } })`. The routes read them from the last user message's `metadata.mentions`,
validated by the existing `mentionsSchema`. `body.mentions` stays a fallback only until the client
half ships. This removes the global `pendingMentions` slot without relying on the per-call `body`
that `use-agent-chat.ts:60-64` drops (G12).

### 5.2 Who sends the turn

After `created` the client calls `sendMessage` **only if** the key is mounted and active in this
tab. It never calls it after `already-stored`, after a `draft-conflict` that reveals a committed
turn, or on a tab that merely loaded the thread. In each of those cases it runs `loadInto(id)` and
bumps the lineage, so `useChat` holds the stored transcript (G13). If the turn has no reply, the
transcript shows it with "No reply arrived" and Retry (`elench-conversation.tsx:223-229`). A send is
then always one visible user action on a visible turn.

### 5.3 Turn claims, before the budget hold

Both chat routes (`app/api/agent/route.ts`, `app/api/projects/[projectId]/assistant/route.ts`) run
`claimTurn(threadId, lastUserMessage.id, trigger, messageId)` after the body validation and **before**
`assertAiAllowed` (`route.ts:201`, `assistant/route.ts:205`). The claim runs in a `withActorScope`
transaction for the named org (§8.1). It works as follows:

| Existing claim | Request | Result |
|---|---|---|
| none | any | insert `running` and continue |
| `running`, lease live | any | **409 `turn-in-progress`**. No hold is reserved. |
| `running`, lease expired, or `failed` | any | compare-and-set to `running` with a new lease and continue |
| `answered` | `trigger = 'regenerate-message'` and `messageId = answer_id` | compare-and-set to `running` and continue. This is an explicit regenerate of an answer the client has seen. |
| `answered` | anything else | **409 `turn-answered`**. No hold is reserved. |

`onFinish` sets `answered` with the assistant message id, after `saveThreadTranscript`. `onError`
and `onAbort` set `failed`. A thrown error between the claim and the stream sets `failed` in the
existing release `catch` (`route.ts:387-392`). The client's 409 handling is D20 in §7.

So a turn is answered, and billed, at most once per claim. The claim's lease bounds a crashed route.
`app/api/agent/route.ts` gains `export const maxDuration = 300` so that the lease is an actual bound
and not an assumption (§1).

The transport passes `trigger` and `messageId` through. That is the one change to
`components/agent/use-agent-chat.ts`, which every chat surface shares: `prepareSendMessagesRequest:
({ messages, body, trigger, messageId }) => ({ body: { ...body, messages, trigger, messageId,
...prepareBody(messages) } })`. An R test asserts the request JSON (G12).

### 5.4 Where a failed first turn lives

| What failed | Where the words are | What every tab and device shows |
|---|---|---|
| The transaction did not commit (an error, a timeout before the commit, the database unreachable) | the draft row at the pre-submit revision, which the flush wrote | The words are in the box. The client then saves `failed_start = { turnId, error, at }` (D11), and every reader shows "Not sent. Retry" with the same `turnId`. |
| The transaction committed, and the response was lost | `agent_threads.messages[0]` | The thread is listed and shows "No reply arrived" + Retry. The claim decides who answers it. |
| The commit and the claim succeeded, and the route then failed (402, provider error, abort) | `agent_threads.messages[0]`, with the claim `failed` | as above. Retry re-claims and is billed once more, because the user asked for a second attempt. |
| The database is unreachable for the flush too | memory and the `sessionStorage` cache only | "Not saved to your account: kept in this tab only. Retrying." (§7) |

## 6. Cross-tab and cross-device semantics

### 6.1 Ownership

A draft row belongs to one key. Any tab or device of the same user in the same org may write it,
but only by compare-and-set. Two tabs on one conversation edit one row. The second writer's stale
base becomes `conflict(row)`, and the client resolves it without losing either text (D14-D16).

### 6.2 Discard is soft and draft-only

`discardDraft` marks the row discarded and keeps its content for **24 hours**. It never calls
`deleteThread`, so a Discard can never delete a conversation that another tab is using (G14). A
committed start is a listed thread whose words are its first message. It has no Discard: removing
it is the rail's Delete, with its confirm. In this tab, Undo calls `restoreDraft`. Another tab that
holds unsaved edits for the row gets `discarded(row)` on its next save. It keeps its words and
shows "Discarded in another tab or device. Restore". Restore is `restoreDraft` followed by a save at
the new base.

### 6.3 Deleting a thread

`deleteThread(id)` keeps its tombstone logic (`agent.ts:195-217`). In the same transaction it also
calls `purge_elench_drafts_of_conversation(id)`. That removes the user's drafts for that
conversation in **every** org, because an org-level thread is listed in every org (§1; G6). The
confirm dialog calls `countDraftsOfConversation` first and names the count and the number of orgs.
After the delete, another tab's next save gets `gone`. Edits it had saved are gone with the thread,
because the confirm counted them. Edits it never saved are words the confirm could not count, so
they move to a new conversation with a notice (D18). Nothing is resurrected (AC16).

### 6.4 What each tab learns, and when

A tab learns about another tab's or device's change at three moments: on its next write (the
outcome), on `listDrafts` (open, focus, scope change, and every 60 s while the surface is open), and
on 409 from a chat route. There is no push channel. A tab whose `local` is empty adopts the server
row silently. A tab that holds unsaved edits never has them overwritten (I5).

## 7. The client: a cache and a save queue

### 7.1 The entry

```ts
interface DraftEntry {
  key: DraftKey;                     // { orgId, anchor, conversationId }, immutable (I2)
  server: ServerDraft | null;        // the last row the server returned
  local: Content | null;             // unacknowledged edits; null when equal to server's content
  epoch: number;                     // bumped ONLY when the box content is replaced from outside (I6)
  sending: { attempt: string; turnId: string; text: string; origin: Origin; at: number } | null; // memory only
  save: "idle" | "saving" | "retrying" | "blocked";
  blockedBy: BlockReason | null;     // §7.4
  conflict: { kind: "edited" | "discarded" | "gone" | "sent"; row: ServerDraft | null } | null;
  thread: ThreadStatus;              // from listDrafts and the start outcomes
}
```

The composer shows `local ?? server.content`. A pending first send shows as a "Sending…" bubble from
`sending.text`. A single per-key queue holds at most one request in flight, and every write goes
through it: `saveDraft`, `startConversation`, `discardDraft` and `restoreDraft`. Edits arriving
during a request are coalesced into the next one.

### 7.2 Transitions

| # | State | Event | Guard | Effect |
|---|---|---|---|---|
| D1 | any | `OPEN_NEW` | the active key is `none`, with no content and no row | none (no clutter) |
| D2 | any | `OPEN_NEW` | otherwise | mint a key. `activeKey[scope] := k'`. The old entry is untouched. |
| D3 | any | `OPEN_ARTIFACT_NEW(a)` | — | mint a key. `local := { …empty, artifacts: [a] }`, saved. No thread row is created. |
| D4 | any | `SELECT(k)` | `k.scope = current` | `activeKey[scope] := k`. If `thread ∈ {listed, unlisted}`, run `loadInto`. Otherwise open the entry without `getThread` (G21). |
| D5 | any | `EDIT(epoch, content)` | `epoch = entry.epoch` | `local := content` (or null when it equals `server.content`). Schedule a save after 800 ms of quiet. |
| D6 | any | `EDIT(epoch, …)` | `epoch ≠ entry.epoch` | dropped. Only D9, D10, D11, D15, D16, D19 and D22 (when it changes the shown content) bump `epoch`, and each of those replaces the box from outside. A list refresh, a save acknowledgement or a persist result never bumps it, so keystrokes typed meanwhile are kept (G16). |
| D7 | dirty | save timer, blur, `visibilitychange: hidden`, before SUBMIT | no request in flight | `saveDraft(base = server?.revision ?? 0, local)` |
| D8 | saving | `saved(r)` | — | `server := { …sent content, revision: r }`. If `local` still equals what was sent, `local := null` and the cache item is removed (I4). Otherwise save again. |
| D9 | Drafting | `SUBMIT` | `thread ∈ {listed, unlisted}` | `epoch++`. Clear the box: `local := empty`. `sendMessage({ text, metadata: { mentions } })`. Save the empty content. |
| D10 | Drafting | `SUBMIT` | `thread ∈ {none, deleted}`, text non-empty and within the limit, no `conflict` | Flush (D7) and await it. Then `sending := { turnId: server.failed_start?.turnId ?? mint(), … }`, `epoch++` and `local := empty`, so the box empties and the bubble shows. Then `startConversation(base = server.revision, origin: composer)`. |
| D10x | any | `SUBMIT_EXTERNAL(text, mentions, cellTarget?)` | `thread ∈ {none, deleted}`, no `sending` | `sending := { …, origin }`. `startConversation(base = server?.revision ?? 0, origin, text, …)`. The box is untouched. |
| D10y | any | `SUBMIT_EXTERNAL` | `thread = listed` | `sendMessage` with its own metadata. The box is untouched. |
| D10z | sending | `SUBMIT` / `SUBMIT_EXTERNAL` / Retry | — | refused: "Wait for the message that is being sent." There is one start in flight per key per tab. Across tabs and devices, the draft's compare-and-set serializes starts. |
| D11 | sending | `START_FAIL(error)` or 30 s with no outcome | `attempt = sending.attempt` | `epoch++`. Put the words back: `local := sending.text + (local ? "\n\n" + local : "")`, which keeps anything typed during the flight. Keep the `turnId`. Save with `failedStart: { turnId, error, at, cellTarget }`. If that save returns `conflict` and the row shows the thread with first id `turnId`, go to D17. `sending := null`. The card reads "Not sent. Your message is back in the box." |
| D12 | sending | `created` | `attempt = sending.attempt` | `server := row`, `thread := listed`, `sending := null`. If `k` is mounted and active, `sendMessage` runs for `turnId` with the stored text and mentions. Otherwise nothing runs, and the transcript shows "No reply arrived" on open. Pending `artifacts` are placed, and a placement that fails gets a toast naming the artifact. |
| D13 | sending | `already-stored` | attempt matches | `server := row`, `thread := listed`, `sending := null`. Then `loadInto(k)` and a lineage bump. **No** `sendMessage` (§5.2). |
| D14 | dirty | `conflict(row)` on save | `local` equals `row.content` | adopt: `server := row`, `local := null` |
| D15 | dirty | `conflict(row)` on save | otherwise | `conflict := edited`. The box keeps `local`. The bar reads "Changed in another tab or device", with **Keep mine** (save at `base = row.revision`) and **Use theirs** (`epoch++`, `local := null`, `server := row`). No autosave runs while the conflict is open. The words stay in memory and the cache. |
| D16 | dirty | `discarded(row)` | — | `conflict := discarded`. The box keeps `local`, with **Restore** (`restoreDraft` and then save) and **Let it go** (`epoch++`, entry removed). |
| D17 | any | `draft-conflict(row)` from `startConversation`, or a D11 save conflict, showing the thread with first id = our `turnId` | — | The turn **was** committed. `thread := listed`, `sending := null`, `loadInto` and a lineage bump, and no auto-send. If `local` holds text other than empty, it stays in the box, and the notice reads "Your first message was sent: '<first 60 chars>'. Your edited text is still in the box." (G20) |
| D18 | any | `deleted` / `conflict` from `startConversation`, or `gone` on save with `local ≠ null` | — | **FORK**: mint `k''` in the same scope, carry `local`, or the start's text and its external prompt, and `artifacts`, and save under `k''` at base 0. `activeKey` moves only if it was `k`. The notice reads "That conversation was deleted. Your message is kept in a new one." or "This conversation was started elsewhere. Your message is kept in a new one." |
| D19 | any | `gone` on save with `local = null`, or `listDrafts` no longer lists `k` | — | `epoch++`. Remove the entry. If the thread is `deleted`, the notice reads "Removed the unsent message of a conversation you deleted." |
| D20 | any | chat route 409 `turn-in-progress` / `turn-answered` | — | No error card. `loadInto(k)` and a lineage bump. While the turn is in progress, the transcript reads "Being answered in another tab or device" and is reloaded when `listDrafts`/`getThread` shows an answer. |
| D21 | Drafting / Failed | `DISCARD` | not `sending` | `discardDraft(base)`. The Undo toast calls `restoreDraft`. A `conflict` answer means another tab changed it, so the discard did not happen; the notice says so and shows that text (D15). |
| D22 | — | `SERVER_ROWS(list)` (`listDrafts` succeeded) | — | For each key: if `local = null`, adopt the row (`epoch++` only when the content differs from what is shown). If `local ≠ null` and the row's revision is newer than our base, set `conflict := edited` (D15). Keys missing from the list go to D19. Thread status is updated. `listDrafts` failing changes nothing (§7.4). |
| D23 | — | `SCOPE_CHANGE(s')` (org switch, an anchor change through `openPanel`/`openModal`/`togglePanel`, `use-elench-store.ts:209-248`) | — | The selector shows only `s'`. `activeKey := activeKey[s']`. Requests in flight carry their own key and never read the active one. `listDrafts` runs for `s'` with a generation guard, so a late answer for `s` is dropped (AC7). |
| D24 | — | any outcome `scope-changed` | — | That key's queue stops (`blocked: scope`). Its words stay in memory and the cache under the **org id** key. The bar reads "This organization's address changed, or this tab now shows another organization. Reload to save." A reload into a page whose actor org equals the key's org re-saves them, and no other org ever sees them (G17). |
| D25 | — | `VIEWER_CHANGE(A → B or none)` from `useViewer()` (`components/providers/viewer-provider.tsx:86-100`) | — | Memory and every cache item are cleared. A's saved drafts are on the server for A. The menu sign-out (`components/shell/sidebar-profile.tsx:76`) confirms first when an entry is unsaved: "N messages are not saved to your account yet and will be lost." |
| D26 | — | `LOAD(scope)` | — | Remove cache items of other viewers. Read this scope's cache items, zod-validated, which are unsaved edits with their base revision. Then `listDrafts`, then D22 with those as `local`. A cached `sending` is restored as D11 (a failed start whose `turnId` is kept). The start was either committed, and D11's save conflicts into D17, or it was not, and the words are back in the box. |
| D27 | — | save fails transiently (network, 5xx, `rate-limited`) | — | `save := retrying`, with backoff 1, 2, 4 … 60 s and an immediate retry on `online`. Raise a notice **each time a key enters** an unsaved state (G19). |
| D28 | — | save `unauthorized` / `forbidden` / `limit` / `too-large` | — | `save := blocked` with the reason (§7.4). The words stay in memory and the cache. |

**Invariants.**
- **I1. One editable text per conversation.** Before a first send the words are the draft. During
  the send they are `sending.text`, which is not editable, and the box is empty. Afterwards they are
  the thread's first message, or back in the box. No moment has two editable copies, so no rule P
  is needed.
- **I2. The key is immutable**: `(orgId, anchor, conversationId)`. Only FORK (D18) re-keys, and
  only into a new key.
- **I3. Nothing evicts words.** Words leave only by D9 or D12 (sent), D19 (gone, with nothing
  unsaved), D21 (discard), D15 "Use theirs", D16 "Let it go", or D25 (viewer change). No cap,
  timeout, storage failure, remount or navigation removes them.
- **I4. The cache holds only unacknowledged words.** A key's `sessionStorage` item exists only while
  `local ≠ null` or `sending ≠ null`, and is removed on D8. A cache write that fails or would cross
  the 1,000,000-code-unit budget is not retried. The key is marked "this tab can't keep it either"
  (§7.4), and Elench never takes room from the canvas draft or the pending paid setup (G7).
- **I5. Unsaved edits are never overwritten** by a server row, a list refresh or another tab.
  Only the user's choice in D15/D16 replaces them.
- **I6. A stale editor update is never applied.** `epoch` changes only when the box is replaced
  from outside (D9, D10, D11, D15, D16, D19, D22-with-change). An `EDIT` stamped with an older epoch
  is dropped. Typing during a refresh or a save is never dropped (G16).
- **I7. A turn is answered at most once per claim** (§5.3), enforced by the server.
- **I8. Tenancy is the server's.** Drafts are keyed by the server-resolved org id. Every action
  compares it with the page's actor (§4 step 3). Every chat request names its org, and the route
  resolves the actor for that org before the claim and the hold (§8.1).

### 7.3 The cache

`sessionStorage["alethia:elench:v3:" + viewerId + ":" + orgId + ":" + anchor + ":" + conversationId]
= { base, local, sending?, epoch }`, zod-validated on read. `activeKey[scope]` is mirrored per tab
under `alethia:elench:v3:active:…`. It holds no words. At the first `LOAD`, every
`alethia:elench:draft:v2:*` and `alethia:elench:drafts:v1` item is removed.

### 7.4 What the user is told (true notices)

The composer footer shows one status per key. It never says "Saved" unless the server acknowledged
exactly the content on screen.

| State | Text |
|---|---|
| acknowledged | "Saved" (shown for 2 s after a save, then nothing) |
| saving | "Saving…" |
| retrying, cache ok | "Not saved to your account yet. Kept in this tab. Retrying." |
| retrying, cache refused | "Not saved. This tab can't keep it either. Copy it before you close the tab." `beforeunload` asks for confirmation. |
| blocked: unauthorized | "Not saved: you are signed out. Sign in again in this tab to save it." |
| blocked: forbidden | "Not saved: you can no longer write in this organization." |
| blocked: scope | D24 |
| blocked: limit | "Not saved: you have 200 unsent messages here. Send or discard some to save this one." |
| blocked: too-large | "Not saved: this message is too long to save. It is kept in this tab only." |
| conflict | D15/D16 |

The rail's Unsent group shows a count of keys that are not acknowledged. A toast is raised each
time a key **enters** an unsaved or blocked state, and it names the conversation (G19).

### 7.5 Flush on leave

A server action cannot ride `sendBeacon` or a `keepalive` fetch. Two mechanisms cover leaving:

- **Reload.** The cache is written after 300 ms of quiet and synchronously on `pagehide`. A reload
  restores the unacknowledged words from it and saves them again (D26).
- **Closing the tab.** `sessionStorage` goes with the tab, so a close loses whatever the server has
  not acknowledged. `visibilitychange: hidden` starts a save at once, and it usually completes. What
  can be lost is at most the edits made since the last acknowledged save: the 800 ms debounce, plus a
  save that was still in flight. When a key is already unsaved for a longer reason (§7.4),
  `beforeunload` asks for confirmation first (Q4).

## 8. Org and account switches, and the chat routes

### 8.1 The chat routes take a named org (unchanged from revision 2, I6)

Every chat request carries its key's `orgId`. Both routes resolve the actor **for that org**, with
`currentActor()`'s three-way check (`guard.ts:39-87`), so the community build keeps working. They do
this before the claim and before the hold. A named org that the caller cannot act in gets a 403 and
reserves nothing. For the project assistant, the project must belong to the named org
(`authorizeQuiet("view", { type: "project", id })` in that org) before the hold (advisory A2). The
session's active org is never the tenant of a chat turn. That fixes the two-tab sequence of G5.

### 8.2 Switches

- **Org switch in this tab**: D23. A's drafts stay on the server for A and are not shown in B.
- **Org switch in another tab**: no effect on this tab's actions. A server action's tenant is this
  tab's page (§1), and a chat request names this tab's org (§8.1).
- **Slug rename or reuse**: D24. The key holds the org id, so a reused slug can never show A's words
  under B. Its actor's org id differs, and the action refuses with `scope-changed`.
- **Account switch or sign-out**: D25. Server drafts are A's, readable only under A's RLS scope.
- **Membership ends** (removed, or suspended through `setMemberSuspended`,
  `app/server/actions/members.ts:242`): `currentActor()` no longer resolves the org, so A cannot
  read those drafts. The sweep deletes them (§9).

## 9. Retention, cleanup and privacy

**Drafts may contain secrets.** People paste kubeconfigs, tokens and connection strings into a chat
box. Under this ruling those strings reach Postgres, and its backups, before anyone decides to
send them. Revision 2 argued against server drafts for this reason, and the ruling accepts the
cost. This design bounds it:

- **Who can read a draft:** only its user, through the app role, in the org it was written in.
  `owner_only` is an AND (§3.3), so org owners and admins cannot read members' drafts. The service
  role can read every row. It is used only by the sweep, the erasure executor and operators with
  database access. No action or route returns another user's draft, and none has an admin view.
- **What is never logged:** draft content, the editor JSON, mentions and failed-start errors that
  echo input. A zod failure is reported by field path only. PostHog's LLM capture
  (`route.ts:322-347`) sees a turn only once it is sent, as today.
- **Retention:** the `elench-drafts-sweep` task runs once a day on the reconcile loop
  (`lib/reconcile/loop.ts`, the same host as `kubeconfig-mint-sweep`). It uses the service role and
  touches only rows whose own timestamps have passed:
  - discarded drafts 24 h after `discarded_at`;
  - active drafts 30 days after `updated_at` (Q2);
  - drafts whose `(user_id, org_id)` no longer has an active `member` row, except the personal org,
    where `org_id = user_id`;
  - turn claims 30 days after `updated_at`.
- **On thread delete:** purged in the same transaction (§6.3).
- **On account delete:** `elench_drafts` and `agent_turn_claims` are added to `ERASURE_RULES` as
  `erase` by `user_id`, next to `agent_threads` (`lib/privacy/erasure-plan.ts:118-127`).
  `tests/privacy/erasure-register-schema.test.ts` then checks the names against the schema.
- **Backups:** a purged draft remains in database backups until the backup retention expires. The
  privacy notice must say so. This is the residual cost the ruling accepts.
- **The tab:** `sessionStorage` holds a key's words only while the server has not acknowledged them
  (I4), and is cleared on a viewer change (D25).

## 10. Migration and rollout (via the db pipeline)

Three PRs. PR 1 holds `mutex:migration`, the board's single-migration lock
(`.claude/skills/db-pipeline/SKILL.md`).

**PR 1: server (needs Q1).**
1. Rebase onto `origin/dev`. Add `elenchDrafts` and `agentTurnClaims` to
   `apps/console/lib/db/schema/agent.ts`, with the JSONB interfaces in
   `apps/console/types/jsonb.types.ts`.
2. Generate in one worktree only: `pnpm -F console db:generate` (`scripts/db-generate.sh` is
   lock-guarded), then `pnpm -F console check:migrations`. Do not edit the generated SQL by hand.
3. In `programmables.sql`: the two `owner_only` AND policies, the two `SECURITY DEFINER` functions
   with `REVOKE … FROM PUBLIC`, and the grants to the app role. They are idempotent
   (`DROP POLICY IF EXISTS`, and `CREATE OR REPLACE` with an explicit `DROP FUNCTION IF EXISTS`
   if a return type ever changes; the 42P13 trap).
4. `app/server/actions/elench-drafts.ts` (§4), `startConversation` (§5.1), and the purge in
   `deleteThread`. `createThread` keeps its signature for the project assistant's callers until PR 2.
5. The routes: named org (§8.1), `claimTurn` (§5.3), mentions from message metadata,
   `maxDuration = 300` on `/api/agent`, and the `use-agent-chat.ts` transport pass-through.
6. The sweep task, and the erasure register rows.
7. Tests: an integration test, `tests/integration/elench-drafts-rls.test.ts`
   (`describeIfDb`). It checks that a member never reads another member's draft in the same org,
   that the org wall holds, and that the purge function never touches another user's rows. Action
   tests in `tests/actions/elench-drafts.test.ts`, and route tests for claims and the named org.
8. An `alethia-security-review` pass. It covers seam 3 (RLS, new tables, the SECURITY DEFINER
   functions), seam 2 (every action gated) and seam 1 (no secret persisted in a column that is
   surfaced or logged; drafts are not `execution_metadata`-like dumps, but they hold user-typed
   secrets).

**PR 2: the client store, the cache and the composer.** This adds `lib/stores/elench-drafts.ts`:
a pure `reduce(entry, event) → { entry, effects }`, the per-key queue, a cache adapter with a fake
that can refuse writes, and the selectors `useDraft(key)` and `useUnsent(scope)`.
- `ElenchComposer` seeds from the entry and reseeds on an `epoch` change.
- `useElenchSend` shrinks to dispatch.
- `pendingMentions` and the `beforeSend` staging are deleted (`elench-conversation.tsx:244-255`,
  `:158-195`; `use-elench-store.ts`).
- `newChat` mints a conversation id.

**PR 3: threads, the rail and notices (a `class:ui` draft PR; see Q3).**
- `useElenchThreads` resumes `activeKey[scope]`, catches `listThreads` and `loadInto` and renders
  the draft with an inline error and Retry (G10), and calls `listDrafts`.
- This PR adds the Unsent group, the footer status, the conflict bar, D20's "Being answered" state,
  the delete-confirm count, and `VIEWER_CHANGE`.

**Rollout order.** The routes accept a request with no named org, and `body.mentions`, until PR 2
ships, so PR 1 can deploy first. The claim applies from PR 1 to every turn. `use-elench-store.ts:100`
("Flipping never remounts the chat") is corrected to "transcript" on the way.

## 11. Cases: what the server model eliminates, and what still needs a transition and a test

**Sources:**
- #5464's 17 acceptance criteria;
- every inline thread, review body and advisory comment on #5423;
- all 21 inline gaps on #5512: G1-G11 from the first review (all resolved against revision 2) and
  G12-G21 from the second review;
- the six advisories in #5512's second review summary (A1-A6).

**Status:** **E** means eliminated by the server model: the mechanism that produced the case no
longer exists. **H** means handled: the case still applies, and a named transition with a test
covers it.

**Test files:**
- **S**: `apps/console/tests/components/elench-drafts-surface.test.tsx`. It drives the real
  `ElenchSurface` / `useElenchThreads` / `ElenchConversation` / store / Lexical stack, with the
  server actions faked in memory **with real compare-and-set semantics**.
- **U**: `tests/lib/stores/elench-drafts.test.ts` (the reducer and the queue).
- **A**: `tests/actions/elench-drafts.test.ts` and `tests/actions/agent.test.ts`.
- **I**: `tests/integration/elench-drafts-rls.test.ts`.
- **R**: the route test files.

Every test must fail on dev @ fbe2409c8 **on its assertion**, not at import (#5423 issue comment
5972776917, adv 1).

### 11.1 #5464 acceptance criteria

| # | Case | St. | How | Test |
|---|---|---|---|---|
| 1 | Minimize/maximize keeps a draft and an edit after a failed start; Retry sends what the box shows | E | The composer is a view of the entry, and D11 puts the failed text back into the box, so Retry is Enter on the box | S › `modal↔panel keeps the restored text and its edit; Retry sends the box` |
| 2 | Text typed during an in-flight first send survives landing → docked | E | D10 empties the box at submit (I1), and new text is new content | S › `words typed while the thread is created stay in the docked box, and the first turn is only what was sent` |
| 3 | Close/reopen keeps a draft and a failed start, for a user with threads | E | Rows are on the server, and reopen resumes `activeKey[scope]` | S › `reopen with threads returns to the failed new conversation` |
| 4 | Each thread keeps its own draft, and re-select keeps it | E | One row per key (I2) | S › `A→B→A→B keeps each draft; re-selecting keeps it` |
| 5 | New chat starts empty and keeps the previous unsent conversation (no single slot) | H | D1, D2 | S › `New chat twice keeps both under Unsent` |
| 6 | Reload keeps the draft and the failed start, and lands where the user was. (The AC's "never stored server-side" is superseded by the 2026-10-04 ruling.) | E | Server rows, the per-tab `activeKey`, and D26 | S › `reload lands on the active conversation with its draft and its Not-sent card` |
| 7 | Org/account switch: A never seeds B; Retry never runs under B; a switch mid-load neither wedges nor writes A under B | H | D23, D24, D25, I8, §8.1 | S › `org switch shows B's empty box and keeps A's failed start for A`; S › `scope change during listDrafts settles for the new scope only`; R › `a turn runs under the named org, not the session's` |
| 8 | A bound never evicts the shown conversation or a failed start; any eviction is visible | E | Nothing evicts (I3). `limit` refuses a new row and says so. | A › `the 201st new draft is refused with limit and existing rows still save`; U › `no event removes words except the listed ones` (property test) |
| 9 | A storage failure is surfaced, and surfaced again after recovery then failure | H | D27, D28, §7.4, a notice per key entry | U › `fail, recover, fail raises two notices` |
| 10 | After a failed write, a reload never brings back sent, cleared or discarded words, including "deploy" → "deploy now" | E | The server row is the truth. The cache holds only unacknowledged edits with their base, and D22 turns a stale base into a conflict, never an overwrite. | S › `a cache item older than the server row becomes a conflict, not a resurrection` |
| 11 | A later send in a thread born from New chat never prunes another conversation's draft | E | No pruning by prefix exists. Each key is a row. | S › `a second send in a new thread leaves New chat's draft saved` |
| 12 | Relocation never hides a failed start; Retry never sends other words | E | There is no relocation. A failed start is the draft's own content plus a marker. | S › `a reaped thread's draft and a failed start stay two rows` |
| 13 | Relocated and then sent never comes back after a reload | E | No relocation; D12 empties the row in the start's own transaction | S › `sending from an Unsent entry removes it for good` |
| 14 | An artifact Open-in-new-chat draft survives a reload and the 1 h reap, and is never labelled "deleted" | E | D3 creates a draft row with `artifacts` and no thread row, so there is nothing to reap | S › `artifact new chat creates no thread; the chip survives a reload; the first send places it` |
| 15 | A reaped thread's draft is kept, and the notice does not say "deleted" | H | `thread = none` with `thread_seen` shows under Unsent as "no longer available" | S › `a reaped thread's draft shows under Unsent as no longer available` |
| 16 | A thread deleted here or elsewhere is not resurrected | H | §6.3 purge in the delete transaction, D19, D18 for unsaved words only | A › `deleteThread purges the user's drafts of that conversation in every org`; S › `delete elsewhere then reload: no draft` |
| 17 | No path writes one conversation's words into another | E | Immutable keys, the start reads its text from its own locked row, mentions ride their own message, and the scope check | U › `no event writes a key other than its own`; A › `startConversation stores the locked row's text, not the input's` |

### 11.2 #5423 review cases outside the ACs

| # | Case | Source | St. | How | Test |
|---|---|---|---|---|---|
| 18 | Retry with an emptied box sent text the user had deleted | 5970188569 adv 3 | E | Retry is Enter on the box. An empty box sends nothing, and the card says the box is empty. | S › `an emptied box sends nothing and says so` |
| 19 | Typing during the in-flight first send left the sent text in the box, so Enter sent it twice | 5973688789 adv 1 | E | D10 empties the box at submit | covered by #2 |
| 20 | The card said "has not been lost" while a close or reload lost it | 5973688789 adv 2 | H | §7.4: the copy derives from the acknowledgement state | S › `the card names where the words are` |
| 21 | Per-keystroke serialization near 100k characters | 5970188569 adv 5 | H | An 800 ms server debounce, a 300 ms cache debounce, and selection-only updates write nothing | U › `selection-only updates write nothing; writes are debounced` |
| 22 | A second account in one tab, where every personal org is `~` | 5970702244 | E | Rows are RLS-bound to the user, the key is an org id and never `~`, and D25 | I › `user B never reads A's draft`; S › `account B in the same tab never sees A's words` |
| 23 | Acknowledging notices wholesale dropped one not yet shown | 5971810475 adv 2 | H | Notices are acknowledged by id | U › `ack removes only the shown notice ids` |
| 24 | An org switch after load wrote A's thread as B's remembered conversation | 5971076371 adv 3 | H | `activeKey` is written per scope from the key's own scope (D23) | S › `org switch after load leaves B's active conversation as it was` |
| 25 | An owner change mid-load wedged the skeleton | 5970752756 adv 3 | H | D23's generation guard, G10's catch | covered by #7 |
| 26 | A `sessionStorage` getter that throws (`SecurityError`) | probe in 5970752756 | E | The cache is optional. The server still saves, and the footer is true. | S › `with storage that throws, drafts still save to the server` |
| 27 | The too-long card stays after the text is shortened | 5970188569 adv 4 | H | The card derives from the entry's text | S › `the too-long card clears once the box is under the limit` |
| 28 | The store keeps `ctx`/`threadId` across an `[org]` remount | first design review on #5512 | H | D23 | covered by #7 and #24 |
| 29 | A stale tab sends into a thread deleted elsewhere | 5972776917 adv 2 | H | `startConversation` returns `deleted`, which goes to D18 | A › `a tombstoned id answers deleted`; S › `send into a deleted conversation keeps the words in a new one` |
| 30 | A draft for an unlisted thread is unreachable | 4174130689 P2; 5970752756 adv 4 | H | `listDrafts` returns every row with its thread status, and the Unsent group shows `none`/`unlisted` | S › `an unlisted thread's draft is shown under Unsent` |
| 31 | A start that completes after a close or org switch sends into an unmounted chat | design review (`elench-surface.tsx:21`) | H | D12's mounted-and-active guard | S › `close during startConversation: reopen shows "No reply arrived"` |
| 32 | A failed suggestion, seed or cell prompt is kept and re-sent as it was | 5969533222; 5969992305 | E | D11 puts the prompt text into the box and keeps its `cellTarget` on the marker | S › `a failed seed prompt survives a reload in the box and Retry sends it with its cell target` |
| 33 | A failed `startThread` sent into `threadId: null`, and a committed-but-unattached row made Retry bill twice | 4173024467 | E | One transaction with a client-minted id, and turn claims | A › `a lost response then Retry answers already-stored`; R › `a second request for a claimed turn is 409 and reserves no hold` |

### 11.3 #5512 inline gaps (G1-G11: first review, resolved on revision 2; G12-G21: second review)

| # | Gap (thread comment id) | St. | How the server model handles it | Test |
|---|---|---|---|---|
| G1 | A PK conflict returned the existing row, so a duplicated tab billed twice and erased the other tab's reply. Different turn ids were rewritten. `RECONCILE(listed)` left `thread=local`. (4177444315) | E | Compare-and-set on the draft serializes starts. The start-outcome table has no rewrite. Claims make a second answer a 409. `listDrafts` reports `listed`. | A › `two startConversation calls at one base: one created, one draft-conflict`; R › `claim 409` ; S › `duplicated tab: Retry in B after A's success loads A's transcript, and a further send from B keeps A's turns` |
| G2 | Nothing held the submitted text; mentions came through a global slot (4177444322) | E | D10 moves the words out of the box (I1). Mentions ride the message metadata (§5.1). | U › `the first turn is exactly the locked row's text`; R › `mentions are read from the last user message` |
| G3 | A persisted in-flight start had no exit; Discard during Starting; Undo; no timeout (4177444324) | E | `sending` is memory only, and the cache restores it as D11. Discard is draft-only. The 30 s timeout is D11, and a late commit surfaces through D17. | S › `reload during startConversation restores the words in the box, or the thread if it committed` |
| G4 | `SUBMIT_EXTERNAL` had no transition, and FORK dropped external text (4177444326) | E | D10x, D10y and D10z. On failure the prompt goes into the box (D11), and FORK carries it (D18). | U › `SUBMIT_EXTERNAL in every state` |
| G5 | I6 was client-only, and the route billed under the session org (4177444337) | H | §8.1, I8 | R › `a named org that differs from the session's runs under the named org`; R › `403 before the hold` |
| G6 | A delete cleared one org's draft, and the confirm undercounted (4177444340) | H | §6.3: purge across orgs, pinned to the current owner, and count in the confirm | A › `purge removes the drafts in orgs A and B, and never another user's`; S › `the confirm counted two` |
| G7 | "Never evict" spent the origin's `sessionStorage` (4177444343) | E | The cache holds only unacknowledged words, within a budget, and refusing it never evicts (I4) | U › `at the budget a cache write is refused and a canvas-draft write still succeeds` |
| G8 | The unmount flush could write a sent message back (4177444345) | E | Writes come from the store's `local`, never from the editor. D10 bumps `epoch`, so a late editor update is dropped (I6). | S › `landing → first send succeeds → unmount → reload: the box is empty` |
| G9 | A sign-out other than the menu left secrets in the tab (4177444348) | H | D25 is raised by `useViewer()`, D26 sweeps other viewers' items, and the cache holds only unsaved words (I4) | S › `a session that ends without the menu clears the cache` |
| G10 | The LOAD-time `getThread` wedged the skeleton; the anchor change was not a scope change (4177444353) | H | PR 3 adds the catch, and the draft renders with an inline error and Retry. The anchor change is D23. | S › `getThread rejecting on load renders the draft with Retry`; S › `project and back restores each anchor's active conversation` |
| G11 | Traceability: no row for 4173024467, wrong citations (4177444357) | H | Row 33. This table cites every source by id. | review |
| G12 | The per-call `body` is dropped by `use-agent-chat.ts:61-63` (4177527031) | H | Mentions move to message metadata (§5.1). The transport passes `body`, `trigger` and `messageId` through (§5.3). `use-agent-chat.ts` and both routes are named in PR 1. | R › `the request JSON carries the message metadata's mentions, trigger and messageId` |
| G13 | `ALREADY_STORED` in a mounted tab left `useChat` empty, so the next Enter overwrote the row (4177527037) | H | D13, D17 and D20 always run `loadInto` and bump the lineage. §5.2 forbids an auto-send. | S › `B gets already-stored, the transcript shows A's turns, and B's next send keeps them in the row` |
| G14 | Discard ran an unconditional `deleteThread` (4177527041) | E | §6.2: Discard is a soft delete of the draft row only. A committed start has no Discard. | A › `discardDraft never changes agent_threads`; S › `Discard in B while A chats in the thread leaves the thread and its widgets` |
| G15 | `checked` was never set on a successful reconcile, and `RECONCILE(absent)` on `local` had no row (4177527043) | E | There is no `checked` and no client gate. Retry is a `startConversation` that the server classifies. | S › `reload after a startConversation that threw: Retry works at once` |
| G16 | I9's rev bump on every non-EDIT transition dropped keystrokes (4177527050) | E | `epoch` bumps only on an outside replacement of the box (I6). A refresh, an acknowledgement or a persist result never bumps it. | U › `an EDIT after a list refresh or a save ack in the same tick is kept` |
| G17 | The key used `orgSlug`, which is renamable and reusable (4177527056) | E | The key is the server-resolved org id. Every action checks it against the page's actor (§4 step 3). | A › `saveDraft with an orgId other than the page actor's is scope-changed and writes nothing`; S › `after a slug rename, the words stay under the org id and save after reload` |
| G18 | After T30, two attempts in one realm could store stale text over an edit (4177527060) | E | No `rewritten` outcome and no realm. A commit adds one to the revision, so every older attempt fails compare-and-set. | A › `a late start at an old base is draft-conflict and stores nothing` |
| G19 | The notice fired only on ∅ → non-∅ (4177527068) | H | A notice is raised each time a key enters an unsaved or blocked state, and it names the conversation (§7.4) | U › `one key permanently unsaved, then another fails: two notices` |
| G20 | T24 after a reload applied rule P to an edited text, and Retry sent the stale snapshot (4177527076) | E | No rule P. D17 keeps the full edited text in the box and states which text was sent. A committed turn is never rewritten. | S › `committed-but-lost start, edit, reload: the box keeps the full edit and the notice names the sent text` |
| G21 | A `gone` Unsent conversation could not be opened (4177527085) | H | D4 opens `none`/`deleted` keys without `getThread` | S › `an Unsent entry whose thread was reaped opens and sends` |

### 11.4 #5512 second-review advisories

| # | Advisory | St. | How | Test |
|---|---|---|---|---|
| A1 | No outcome for "the insert wrote nothing and the RLS read found nothing" | H | Named `conflict` in §5.1, then D18 | A › `an id held by another owner answers conflict` |
| A2 | I6 named the billing org but did not check the project | H | §8.1: the project must be visible in the named org, checked before the hold | R › `a project of another org is 403 before the hold` |
| A3 | A stored first turn has no mentions | E | Mentions are stored in the first message's metadata (§5.1) | A › `the stored first turn carries its mentions` |
| A4 | An entry with `artifacts` and no words had no state name | E | States are not derived from content any more. An artifacts-only draft is an ordinary row, and D1 checks "no content". | U › `D1 with an artifacts-only draft mints a new key` |
| A5 | A stale tab can rebuild a conversation deleted more than a day ago | H | **The first-send path.** While the tombstone lives, `startConversation` answers `deleted`, and D18 forks to a new key. After the tombstone is reaped, a start from a stale draft creates a thread under the old id that holds only the first turn, read from the draft row, never the old transcript. **A stale tab's later turn** that carries the old transcript is transcript saving (§12, Q8). | A › `a start after the tombstone is reaped stores only the first turn` |
| A6 | The count line said rows 18-46 | E | This table replaces it (§11.5) | — |

### 11.5 Count

The table has 60 cases: 17 ACs, 16 #5423 review cases, 21 #5512 gaps and 6 advisories.
**33 are eliminated** by the server model (E) and **27 are handled** by a transition and a test (H).

## 12. Out of scope

- **Later turns that fail after hand-off** stay in the client transcript until `onFinish` saves
  them. That is server-side transcript saving (`lib/agent/thread-transcript.ts`), which #5464
  excludes.
- **A stale tab's later turn overwrites the transcript.** The routes save the client's
  `originalMessages` wholesale (`route.ts:282`, `:376-383`). Claims stop a turn from being
  answered twice. They do not stop a tab with an old transcript from sending a **new** turn whose
  save replaces newer turns. The fix is a transcript revision checked by compare-and-set at save
  time, in a separate issue (Q8).
- Whether org-level threads should be org-scoped server-side (Q6).
- Lexical undo history across a remount, which is per mount.
- Real-time push of another device's edits. A tab learns at the moments in §6.4.

## 13. Open questions for the maintainer

Each has a recommended answer.

1. **Widen #5464's scope to the server.** That covers the two new tables and the policies, the
   actions, `startConversation`, the `deleteThread` purge, claims in both chat routes, the named
   org, `maxDuration` on `/api/agent`, the `use-agent-chat.ts` transport, the sweep and the erasure
   rows. All of these are outside #5464's `scope:` globs. **Recommended: approve**, with PR 1
   holding `mutex:migration` and an `alethia-security-review` pass. Without claims, double billing
   is not prevented (G1, G18). Without the named org, AC7 cannot be met (G5).
2. **Retention of active drafts.** **Recommended: 30 days after the last edit**, and 24 h for
   discarded ones. A longer window keeps pasted secrets at rest for longer, and 30 days covers a
   holiday.
3. **The Unsent rail group and the footer status are new UI.** **Recommended: PR 3 is a
   `class:ui` draft PR**, per `.claude/COORDINATION.md`.
4. **Flush on tab close.** Server actions cannot use `keepalive`, and `sessionStorage` closes with
   the tab. **Recommended: accept** that a tab close can lose the edits since the last acknowledged
   save (§7.5): the save on `visibilitychange: hidden` covers most of them, and `beforeunload` asks
   when a key is already unsaved. The alternative is a `keepalive` route handler with its own CSRF
   and named-org checks, and a 64 KB body cap. Revisit it if telemetry shows real loss.
5. **Conflict default.** **Recommended: never auto-merge text.** Adopt silently only when the tab has
   no unsaved edits (D14, D22). Otherwise show Keep mine / Use theirs (D15).
6. **Org-level threads are user-scoped** (`agent.ts:97`), so one thread is listed in every org, with
   a draft per org. **Recommended: a separate issue** to make them org-scoped. §6.3 is correct
   either way.
7. **A paste that looks like a credential.** **Recommended: show a one-line inline notice the
   first time per draft**: "Drafts are saved to your account. Avoid pasting credentials." Do not
   block or redact. Detection is client-side and best-effort, and the notice must not claim more.
8. **Transcript compare-and-set for later turns** (§12). **Recommended: open a follow-up issue.**
   It is the same pattern as §4, applied to `agent_threads`.
9. **The claim lease of 330 s.** **Recommended: accept**, with `maxDuration = 300` declared on both
   routes. The 30 s margin covers the `onFinish` save.
10. **The 200-draft limit per scope.** **Recommended: 200.** It refuses new rows only, never
    evicts, and says so.
11. **Regenerate of an answered turn re-bills by design** (§5.3, the `regenerate-message` arm). It
    needs the answer id the client saw, so a stale tab cannot regenerate an answer it never
    displayed. **Recommended: accept.**
12. **The 30 s start timeout** (D11). **Recommended: 30 s.** A late commit is safe, because
    compare-and-set turns it into D17.
