<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Elench drafts: server-side rows keyed by (user, org id, conversation), saved by compare-and-set

**Status:** proposed (2026-10-04, revision 4) · **Issue:** #5464 · **Supersedes:** revision 2 of this
ADR (833e4e9c4, a client-only `sessionStorage` store) and the draft store reverted from #5423 (head
2c1314267)

**Scope (revision 4).** This ADR covers **draft persistence only**: typed text and the text of a
failed first send are never lost, across tabs, devices, reloads, org switches, slug renames and
suspension, and every notice about them is true. **Turn idempotency** (answering and billing a chat
turn exactly once, turn claims and leases, `maxDuration`, the HITL continuation, the chat routes'
billing org, and transcript compare-and-set for later turns) moved to **#5515**, a design-first issue
of its own. Revision 3's `agent_turn_claims` table, its claim table and its route changes are
removed from this document. §5.3 states the one interface drafts need from #5515, and what drafts do
while it is open.

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
4. **Drafts never send a stored turn twice on their own.** A committed first turn is loaded, never
   re-sent (§5.2), and its id is fixed at commit. Whether the **server** answers and bills a turn
   once is #5515's question; drafts use only the interface in §5.3 and change nothing in the chat
   routes' billing until it lands.
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
| A client guess about server state | #5512: G1, G3, G13, G14, G15, G16, G18, G21 | Compare-and-set outcomes and the start-outcome table, each carrying the thread's committed first-turn id. The client never infers. |
| A turn billed twice | #5423: 4173024467; #5512: G1, G18 | **Moved to #5515.** Drafts contribute the client-minted, never-re-minted first-turn id (§5.3). |

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
- The project assistant declares `maxDuration = 300` (`app/api/projects/[projectId]/assistant/route.ts:51`),
  but nothing enforces it: the console ships as `output: "standalone"` (`next.config.ts:35`) and runs
  as `node apps/console/server.js` (`Dockerfile:87`), with no `vercel.json`, and `maxDuration` is a
  deployment-platform setting. The comment at `agent.ts:121` that leans on it is wrong. Both facts
  belong to #5515; nothing in this ADR depends on a route duration.
- **The tenant of a chat turn is the session's org**, which every tab shares. Both routes call
  `currentActor()` (`route.ts:171`; `assistant/route.ts:181`). That prefers the org in the URL and
  falls back to `active_organization_id` where the address names none, which includes `/api/**`
  (`lib/authz/guard.ts:27-38`; `lib/authz/org-scope.ts:24-25`). `switchOrg` writes the session
  value (`lib/stores/use-workspace-store.ts:50-53`).
- **A server action's tenant is the page's org.** The proxy publishes the request path on
  `x-alethia-path`. A server action is a POST to the page's own path, and a forwarded action keeps
  the first pass's value (`lib/authz/org-path.ts:16-21`). So `currentActor()` inside an action
  invoked from `/acme/…` resolves `acme`. When the page's slug names no org in which the caller holds
  an **active** `member` row, `urlScopedOrgId` calls `notFound()` (`org-scope.ts:100-116`, the call
  at `:153`), and `currentActor()` propagates the throw. That covers a renamed slug, a slug that
  never existed, a removed member and a suspended one (`setMemberSuspended`,
  `app/server/actions/members.ts:242`; the `status = 'active'` join is `org-scope.ts:112`). The
  throw's digest starts with `NEXT_HTTP_ERROR_FALLBACK`, which `isExpectedRequestError` already
  recognizes (`lib/errors.ts:67-77`).
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

### 3.2 The key and the policy agree

Revision 3's turn-claim table had a global primary key under an org-scoped policy, so a row made in
one org was invisible to, and collided with, the same key in another (#5512 thread 4177659592; the
claim table moved to #5515). `elench_drafts` is built so that cannot happen:

- **No visible-key collision.** The only unique constraint is `(user_id, org_id, conversation_id)`,
  and its columns are exactly the two the policy pins plus the conversation. A row that RLS hides
  from a transaction always differs from that transaction's rows in `user_id` or `org_id`, so it
  can never violate a unique check for an insert that transaction makes. The same conversation id
  in two orgs (an org-level thread is listed in every org, §1) is two rows, by design (§6.3).
- **The row id is never a key.** `id` is server-minted and never sent by a client (§3.1), so no
  input names a row the caller cannot see.
- **No foreign key to `agent_threads`.** A draft exists before its thread does (§5.1), and the
  thread's `org_id` is the user id, not the draft's org (§1). Removal with the thread is the
  owner-pinned purge in §3.3, called inside `deleteThread`'s transaction (§6.3), not a cascade.
- **The sweep** runs as the service role (§9), which RLS does not filter.

An I test asserts the first point: in one database, user U inserts `(U, A, C)` under org A and
`(U, B, C)` under org B, and both succeed.

### 3.3 RLS

`elench_drafts` gets its **own** policy in `programmables.sql`, modelled on
`kubeconfig_mint_requests` (`:1167-1176`). It is deliberately **not** added to the `owner_all`
OR loop (`:1127`):

```sql
CREATE POLICY owner_only ON public.elench_drafts FOR ALL
  USING (user_id = current_setting('app.current_owner', true)::uuid
         AND org_id = current_setting('app.current_org', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_owner', true)::uuid
         AND org_id = current_setting('app.current_org', true)::uuid);
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
   **A `notFound()` from that call is caught here and never reaches the client as a throw.** The
   action recognizes it by its digest (`NEXT_HTTP_ERROR_FALLBACK`, the shape
   `isExpectedRequestError` tests, `lib/errors.ts:67-77`) and rethrows anything else, including a
   redirect. It then decides, with one service-role read of the **caller's own** membership, which
   of two true things happened:
   - `input.orgId === userId`, or the caller still holds an **active** `member` row in
     `input.orgId`: the org still exists for this user under another address. The slug was renamed
     (or now names nothing). The outcome is `scope-changed { reason: "address", slug }`, where
     `slug` is the org's current slug (`~` for the personal org). It writes nothing.
   - Otherwise (removed, suspended, or the org is gone): the outcome is `forbidden { reason:
     "membership" }`. It writes nothing.

   The read names only `input.orgId` and the session's user id, so it reveals nothing to a caller
   that a membership list does not already show them. It never trusts `input.orgId` as a tenant;
   it only chooses which refusal to return.
3. It refuses with outcome `scope-changed { reason: "other-org" }` when `input.orgId !==
   actor.orgId`, and writes nothing. The client got `orgId` from `listDrafts`, so a mismatch after a
   successful resolve means the tab's slug now names another org the caller belongs to (a reused
   slug). A change of signed-in person never reaches here with the old key, because D25 clears the
   tab first.
4. It authorizes **quietly**, because an autosave is not an activity-log event (`guard.ts:106-122`).
   For an org anchor it calls `authorizeQuiet("view", { type: "org" })`. For a project anchor it
   calls `authorizeQuiet("view", { type: "project", id })`, so a project draft needs the project
   to be visible in **this** org.
5. It runs in `withActorScope(actor, tx => …)` (`lib/db/index.ts:108-113`), so both RLS
   variables are the actor's. `agent_threads` rows still pass `owner_all` through
   `user_id = current_owner`.
6. It returns a discriminated union. It never throws for an expected outcome: an
   `UnauthorizedError` becomes `unauthorized`, a `ForbiddenError` becomes `forbidden`, and a
   `notFound()` becomes `scope-changed` or `forbidden` by step 2. A database error is caught and
   returned as `unavailable`, which is **transient**. On the client, a rejected action call that is a
   network failure (offline, fetch error) is transient as well. Any **other** rejection is retried at
   most three times (D27) and then becomes `blocked: error` (§7.4). It is never retried for ever,
   because retrying a deterministic throw behind a "Retrying" footer is exactly #5512 thread
   4177659600.
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
| `saveDraft` | key, `baseRevision` (0 = none yet), content, `failedStart?`, `threadSeen?`, `tabId` | Locks the row `FOR UPDATE`. Inserts when `baseRevision = 0` and no row exists. Updates when `revision = baseRevision` and the row is active. Sets `failed_start` only when the input names one; `null` clears it. Sets `thread_seen` only when the server finds the thread row. | `saved(revision)` · `conflict(row, thread)` · `discarded(row, thread)` · `gone(thread)` (no row, and `baseRevision > 0`) · `limit` (§4.3) · `too-large` · `invalid` · `scope-changed` · `unauthorized` · `forbidden` · `rate-limited` · `unavailable` |
| `discardDraft` | key, `baseRevision` | Sets `status = 'discarded'` and `discarded_at = now()`, and adds one to `revision`, when `revision = baseRevision`. **It never touches `agent_threads`.** | `discarded(revision)` · `conflict(row, thread)` · `gone(thread)` |
| `restoreDraft` | key, `baseRevision` | Sets the row back to active when it is discarded at `baseRevision`. | `saved(revision)` · `conflict(row, thread)` · `gone(thread)` |
| `startConversation` | key, `baseRevision`, `turnId`, `origin`, external text and mentions when `origin ≠ composer`, `cellTarget?`, `title` | §5 | §5 |
| `deleteThread` (changed) | `{ id }` | As today, plus `purge_elench_drafts_of_conversation(id)` in the same transaction (§6.3) | `{ purged }` |
| `countDraftsOfConversation` | `{ id }` | For the delete confirm | `{ count, orgs }` |

**`thread` on every refusal.** Each `conflict`, `discarded`, `gone` and `draft-conflict` outcome
carries `thread: { status, firstTurnId }`, read from `agent_threads` **in the same transaction** as
the row it returns. `status` is §2's thread status, and `firstTurnId` is `messages->0->>'id'` of a
live row, or null when there is no live row or it has no messages. This is what lets the client
tell "my own start committed" from "another tab edited the draft" without guessing (D17, #5512
thread 4177659608). The read runs under `withActorScope`, where `agent_threads`' `owner_all` passes
on `user_id = current_owner` (§4 step 5), so it sees only the caller's own threads.

### 4.3 Bounds

`saveDraft` refuses a **new** row when the scope already holds 200 active drafts. That refusal is
`limit`. An existing row is never refused for the count, and nothing is ever evicted (I3). The
client keeps the words in the tab and says so (§7).

## 5. First send and failed first turn

### 5.1 `startConversation`

```
startConversation({ orgId, projectId, conversationId, baseRevision, turnId, origin,
                    text?, mentions?, cellTarget?, title })
```

The whole action is **one** `withActorScope` transaction:

1. `SELECT … FROM elench_drafts WHERE (user, org, conversation) FOR UPDATE`.
   - The row exists and `revision ≠ baseRevision`, or the row is discarded: return
     `draft-conflict(row, thread)` (§4.2: `thread` carries the status and the committed first-turn
     id). Nothing is written.
   - The row is absent and `baseRevision > 0`: return `draft-conflict(null, thread)`.
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
(advisory A3). From now on every turn also carries its mentions on its own message: `sendMessage({
text, metadata: { mentions } })`. **This ADR changes no chat route**, so the routes keep reading
`body.mentions`, which the existing `pendingMentions` slot feeds through `prepareBody`
(`elench-conversation.tsx:158-195`, `:244-255`), exactly as on dev. The slot is staged
synchronously before the `sendMessage` of the same key, so it carries that send's mentions. Reading
them from the last user message's `metadata.mentions` instead, and then deleting the slot, is a
route change and belongs to #5515 (G12).

### 5.2 Who sends the turn

After `created` the client calls `sendMessage` **only if** the key is mounted and active in this
tab. It never calls it after `already-stored`, after a `draft-conflict` that reveals a committed
turn, or on a tab that merely loaded the thread. In each of those cases it runs `loadInto(id)` and
bumps the lineage, so `useChat` holds the stored transcript (G13). If the turn has no reply, the
transcript shows it with "No reply arrived" and Retry (`elench-conversation.tsx:223-229`). A send is
then always one visible user action on a visible turn.

### 5.3 The interface drafts need from #5515, and what drafts do while it is open

Answering and billing a turn exactly once is #5515. Drafts need exactly two things from it, and
nothing else:

1. **A send carries a client turn id.** It is the user message's own id. For a first turn, drafts
   mint it at D10 and `startConversation` stores it as `messages[0].id`. It is kept across a failed
   start on the failed-start marker (§2) and across a reload through the cache (D26), and it is
   **never re-minted for a turn that is stored**: a committed start is loaded, not sent again (§5.2,
   D13, D17). So `(thread id, turn id)` names one turn from its birth, which is the key #5515 needs.
2. **A refused send says whether its turn is committed and answered** (for example a typed 409,
   `turn-in-progress` or `turn-answered`). The client then loads the stored transcript (D20) and
   shows no error card.

Drafts never read the chat route's billing org. A draft's tenant is the server action's page org
(§4), checked against the key on every write.

**While #5515 is open, nothing about turns regresses against dev @ fbe2409c8.**
- The chat routes, `components/agent/use-agent-chat.ts` and the budget hold are not changed by this
  ADR. D20 is dormant: no route returns its refusal yet.
- A committed start is sent **at most once by this design**: only the tab whose start returned
  `created`, and only while the key is mounted and active (D12). Every other path loads the
  transcript (§5.2). Today a lost `createThread` response makes Retry call it again and send again
  (#5423 4173024467), so this is strictly fewer sends.
- Retry on "No reply arrived" is `regenerate()`, as today (`elench-conversation.tsx:223-229`, `:302`).
  Two tabs that both press it can still both be answered and billed, as today. That case is #5515's.
- A later turn sent from a tab whose transcript is older than the row still replaces the row on
  save, as today (§12). Drafts only guarantee that **this design** never puts a tab in that state
  without loading the transcript first (D9, D22).

### 5.4 Where a failed first turn lives

| What failed | Where the words are | What every tab and device shows |
|---|---|---|
| The transaction did not commit (an error, a timeout before the commit, the database unreachable) | the draft row at the pre-submit revision, which the flush wrote | The words are in the box. The client then saves `failed_start = { turnId, error, at }` (D11), and every reader shows "Not sent. Retry" with the same `turnId`. |
| The transaction committed, and the response was lost | `agent_threads.messages[0]` | The thread is listed and shows "No reply arrived" + Retry (D17 loads it; nothing auto-sends). Who answers a Retry pressed in two places is #5515. |
| The commit succeeded, and the route then failed (402, provider error, abort) | `agent_threads.messages[0]` | as above. Retry is a second attempt the user asked for, and is billed as today. |
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
on a chat route's refusal once #5515 lands (D20). There is no push channel. A tab whose `local` is
empty adopts the server row silently. A tab that holds unsaved edits never has them overwritten (I5).

## 7. The client: a cache and a save queue

### 7.1 The entry

```ts
interface DraftEntry {
  key: DraftKey;                     // { orgId, anchor, conversationId }, immutable (I2)
  server: ServerDraft | null;        // the last row the server returned; null = this tab has never seen a row
  local: Content | null;             // unacknowledged edits; null when equal to server's content
  epoch: number;                     // bumped ONLY when the box content is replaced from outside (I6)
  submit: { attempt: string; content: Content } | null;            // a SUBMIT waiting on its flush (D10)
  sending: { attempt: string; turnId: string; text: string; origin: Origin; at: number } | null; // memory only
  save: "idle" | "saving" | "retrying" | "blocked";
  blockedBy: BlockReason | null;     // §7.4
  conflict: { kind: "edited" | "discarded" | "gone" | "sent"; row: ServerDraft | null } | null;
  thread: ThreadStatus;              // from listDrafts and every outcome's `thread` (§4.2)
  transcript: "unloaded" | "loading" | "loaded"; // whether useChat holds this key's stored transcript
  ackSeq: number;                    // the request sequence number of the last write the server answered
}
```

The composer shows `local ?? server.content`, and is read-only while `submit ≠ null` (one flush, D10).
A pending first send shows as a "Sending…" bubble from `sending.text`. A single per-key queue holds
at most one request in flight, and every write goes through it: `saveDraft`, `startConversation`,
`discardDraft` and `restoreDraft`. Edits arriving during a request are coalesced into the next one.
Every request, `listDrafts` included, takes a sequence number from one per-tab counter when it is
**sent**.

### 7.2 Transitions

| # | State | Event | Guard | Effect |
|---|---|---|---|---|
| D1 | any | `OPEN_NEW` | the active key is `none`, with no content and no row | none (no clutter) |
| D2 | any | `OPEN_NEW` | otherwise | mint a key. `activeKey[scope] := k'`. The old entry is untouched. |
| D3 | any | `OPEN_ARTIFACT_NEW(a)` | — | mint a key. `local := { …empty, artifacts: [a] }`, saved. No thread row is created. |
| D4 | any | `SELECT(k)` | `k.scope = current` | `activeKey[scope] := k`. If `thread ∈ {listed, unlisted}`, run `loadInto` (`transcript := loading`, then `loaded`). Otherwise open the entry without `getThread` (G21); `transcript := loaded`, because there is nothing stored to load. |
| D5 | any | `EDIT(epoch, content)` | `epoch = entry.epoch`, `submit = null` | `local := content` (or null when it equals `server.content`). Schedule a save after 800 ms of quiet. |
| D6 | any | `EDIT(epoch, …)` | `epoch ≠ entry.epoch` | dropped. Only D9, D10b, D11, D15, D16, D17b, D19 and D22 (when it changes the shown content) bump `epoch`, and each of those replaces the box from outside. A list refresh, a save acknowledgement or a persist result never bumps it, so keystrokes typed meanwhile are kept (G16). |
| D7 | dirty | save timer, blur, `visibilitychange: hidden`, before SUBMIT | no request in flight | `saveDraft(base = server?.revision ?? 0, local)` |
| D8 | saving | `saved(r)` | — | `server := { …sent content, revision: r }`, `ackSeq := seq`. If `local` still equals what was sent, `local := null` and the cache item is removed (I4). Otherwise save again. |
| D9 | Drafting | `SUBMIT` | `thread ∈ {listed, unlisted}`, `transcript = loaded` | `epoch++`. Clear the box: `local := empty`. `sendMessage({ text, metadata: { mentions } })`. Save the empty content. |
| D9a | Drafting | `SUBMIT` | `thread ∈ {listed, unlisted}`, `transcript ≠ loaded` | **No send.** The box is untouched. `loadInto(k)` and a lineage bump. The notice reads "This conversation has messages from another tab or device. They are shown now. Press Enter to send." A later SUBMIT is D9. (#5512 thread 4177659625) |
| D10 | Drafting | `SUBMIT` | `thread ∈ {none, deleted}`, text non-empty and within the limit, no `conflict`, `submit = null` | `submit := { attempt, content: what the box shows }`. The box goes read-only. Flush (D7) and await **its own outcome**. If `local = null` already and `server.content` equals the box, the flush is a no-op that counts as `saved(server.revision)`. |
| D10b | submitting | the flush answers `saved(r)` | `attempt = submit.attempt`, and the acknowledged content equals `submit.content` | `sending := { turnId: server.failed_start?.turnId ?? mint(), text: submit.content.text, … }`, `submit := null`, `epoch++` and `local := empty`, so the box empties and the bubble shows. Then `startConversation(base = r, origin: composer)`. The server reads the text from the row at `r` (§5.1 step 2), which is exactly what the box showed. |
| D10c | submitting | the flush answers anything else (`conflict`, `discarded`, `gone`, `limit`, `too-large`, `invalid`, `scope-changed`, `forbidden`, `unauthorized`, transient) | `attempt = submit.attempt` | `submit := null`. **Nothing is sent**, and the box is untouched and editable again. The outcome then takes its own transition (D14-D16, D18, D24, D27, D28), and the notice is prefixed "Not sent:". (#5512 thread 4177659605) |
| D10x | any | `SUBMIT_EXTERNAL(text, mentions, cellTarget?)` | `thread ∈ {none, deleted}`, no `sending` | `sending := { …, origin }`. `startConversation(base = server?.revision ?? 0, origin, text, …)`. The box is untouched. |
| D10y | any | `SUBMIT_EXTERNAL` | `thread = listed`, `transcript = loaded` | `sendMessage` with its own metadata. The box is untouched. (With `transcript ≠ loaded`, D9a first.) |
| D10z | sending or submitting | `SUBMIT` / `SUBMIT_EXTERNAL` / Retry | — | refused: "Wait for the message that is being sent." There is one start in flight per key per tab. Across tabs and devices, the draft's compare-and-set serializes starts. |
| D11 | sending | `START_FAIL(error)` or 30 s with no outcome | `attempt = sending.attempt` | `epoch++`. Put the words back: `local := sending.text + (local ? "\n\n" + local : "")`, which keeps anything typed during the flight. Keep the `turnId` in memory. Save with `failedStart: { turnId, error, at, cellTarget }`. That save's `conflict(row, thread)` / `gone(thread)` is classified by **the start table** below, with `turnId` as ours. `sending := null`. The card reads "Not sent. Your message is back in the box." |
| D12 | sending | `created` | `attempt = sending.attempt` | `server := row`, `thread := listed`, `transcript := loaded` (the tab's `useChat` holds exactly the new turn), `sending := null`. If `k` is mounted and active, `sendMessage` runs for `turnId` with the stored text and mentions. Otherwise nothing runs, and the transcript shows "No reply arrived" on open. Pending `artifacts` are placed, and a placement that fails gets a toast naming the artifact. |
| D13 | sending | `already-stored` | attempt matches | `server := row`, `thread := listed`, `sending := null`. Then `loadInto(k)` and a lineage bump. **No** `sendMessage` (§5.2). |
| D14 | dirty | `conflict(row)` on save | `local` equals `row.content` | adopt: `server := row`, `local := null` |
| D15 | dirty | `conflict(row)` on save | otherwise, and the start table does not apply | `conflict := edited`. The box keeps `local`. The bar reads "Changed in another tab or device", with **Keep mine** (save at `base = row.revision`) and **Use theirs** (`epoch++`, `local := null`, `server := row`). No autosave runs while the conflict is open. The words stay in memory and the cache. |
| D16 | dirty | `discarded(row)` | — | `conflict := discarded`. The box keeps `local`, with **Restore** (`restoreDraft` and then save) and **Let it go** (`epoch++`, entry removed). |
| D17 | any | the start table answers **ours** | — | Our turn **was** committed. `thread := listed`, `sending := null`, `loadInto` and a lineage bump, and no auto-send. If `local` holds text other than empty, it stays in the box, and the notice reads "Your first message was sent: '<first 60 chars>'. Your edited text is still in the box." (G20) |
| D17b | sending | the start table answers **not committed** | attempt matches | `epoch++`. The words go back: `local := sending.text + (local ? "\n\n" + local : "")`. `sending := null`. Then D15 with the returned row, so the user chooses **Keep mine** or **Use theirs** in the open, and nothing is sent. The `turnId` is dropped: no turn with it was stored, so the next send may mint a new one. (#5512 thread 4177659605) |
| D18 | any | the start table answers **another turn** or **deleted**, or `conflict` from `startConversation` (§5.1 step 5), or `gone(thread)` on save with `local ≠ null` | — | **FORK**: mint `k''` in the same scope, carry `local`, `sending.text` (or the start's external prompt) and `artifacts`, and save under `k''` at base 0. `sending := null`. `activeKey` moves only if it was `k`. The notice reads "That conversation was deleted. Your message is kept in a new one." or "This conversation was started from another tab or device. Your message is kept in a new one." |
| D19 | any | `gone(thread)` on save with `local = null` and `sending = null` | — | `epoch++`. `server := null`. If `k` is not the active key, remove the entry. If the thread is `deleted`, the notice reads "Removed the unsent message of a conversation you deleted." |
| D19L | any | `listDrafts` (request sequence `q`) no longer lists `k` | `local = null`, `sending = null`, `submit = null`, `server ≠ null`, **and** `ackSeq < q` | as D19. A key the server never acknowledged (`server = null`: a `limit`, `too-large`, `forbidden` or still-in-flight first save) is **never** removed by a list, and neither is a key whose last write was answered after the list was requested. A key with unsaved words leaves only through a write's own outcome. (#5512 thread 4177659614) |
| D20 | any | a chat route refuses a turn as in progress or answered (#5515, §5.3) | — | **Dormant until #5515 lands.** No error card. `loadInto(k)` and a lineage bump. While the turn is in progress, the transcript reads "Being answered in another tab or device" and is reloaded when `listDrafts`/`getThread` shows an answer. |
| D21 | Drafting / Failed | `DISCARD` | not `sending`, not `submit` | `discardDraft(base)`. The Undo toast calls `restoreDraft`. A `conflict` answer means another tab changed it, so the discard did not happen; the notice says so and shows that text (D15). |
| D22 | — | `SERVER_ROWS(list)` (`listDrafts`, request sequence `q`, succeeded for the current scope generation) | — | Only keys of the list's own scope are read. For each listed key with `ackSeq < q`: if `local = null` and `submit = null`, adopt the row (`epoch++` only when the content differs from what is shown); if `local ≠ null` and the row's revision is newer than our base, set `conflict := edited` (D15). A key whose last write was answered after `q` keeps its newer state. Unlisted keys go to D19L. Thread status is updated, and **when a mounted key's status changes from `none`/`deleted` to `listed`/`unlisted`, run `loadInto(k)` and bump the lineage**, as D13 does (`transcript := loading`, then `loaded`). `listDrafts` failing changes nothing (§7.4). (#5512 thread 4177659625) |
| D23 | — | `SCOPE_CHANGE(s')` (org switch, an anchor change through `openPanel`/`openModal`/`togglePanel`, `use-elench-store.ts:209-248`) | — | The selector shows only `s'`. `activeKey := activeKey[s']`. Requests in flight carry their own key and never read the active one. `listDrafts` runs for `s'` with a generation guard, so a late answer for `s` is dropped (AC7). |
| D24 | — | any outcome `scope-changed` | — | That key's queue stops (`blocked: scope`) and is **never retried**. Its words stay in memory and the cache under the **org id** key. For `reason: "address"` the bar reads "This organization's address changed. Open it at its new address in this tab to save." with a link to the same path under the returned slug; following the link in this tab keeps the cache, and D26 saves the words there. For `reason: "other-org"` it reads "This tab now shows another organization. Your message was not saved there. Go back to <org name> in this tab to save it." No other org ever sees the words (G17; #5512 thread 4177659600). |
| D25 | — | `VIEWER_CHANGE(A → B or none)` from `useViewer()` (`components/providers/viewer-provider.tsx:86-100`) | — | Memory and every cache item are cleared. A's saved drafts are on the server for A. The menu sign-out (`components/shell/sidebar-profile.tsx:76`) confirms first when an entry is unsaved: "N messages are not saved to your account yet and will be lost." |
| D26 | — | `LOAD(scope)` | — | Remove cache items of other viewers. Read this scope's cache items, zod-validated, which are unsaved edits with their base revision. Then `listDrafts`, then D22 with those as `local`. A cached `sending` is restored as D11 (a failed start whose `turnId` is kept). The start was either committed, and D11's save is classified by the start table into D17, or it was not, and the words are back in the box. |
| D27 | — | a write fails transiently (`unavailable`, `rate-limited`, a network failure) | — | `save := retrying`, with backoff 1, 2, 4 … 60 s and an immediate retry on `online`. Any **other** rejected call is retried at most three times and then goes to D28 as `error` (§4 step 6). Raise a notice **each time a key enters** an unsaved state (G19). |
| D28 | — | a write answers `unauthorized` / `forbidden` / `limit` / `too-large` / `invalid`, or D27 gives up with `error` | — | `save := blocked` with the reason (§7.4). The words stay in memory and the cache. A blocked key is not retried automatically, except `unauthorized` (retried once after the viewer signs in again in this tab) and `limit` (retried when another draft of the scope is sent or discarded). |

**The start table.** It classifies a `draft-conflict(row, thread)` from `startConversation`, and a
`conflict(row, thread)` or `gone(thread)` answering D11's failed-start save. `turnId` is the turn id
of this tab's `sending` (or the one D11 kept). It reads only `thread`, which the server read in the
same transaction (§4.2), so it never guesses.

| `thread.status` | `thread.firstTurnId` | Answer | Transition |
|---|---|---|---|
| `listed` | `= turnId` | **ours** | D17 |
| `listed` | `≠ turnId` | **another turn** | D18 ("started from another tab or device") |
| `deleted` | any | **deleted** | D18 ("deleted") |
| `none` or `unlisted` | null | **not committed** | D17b from a start; D15 (or D18 for `gone`) from a D11 save |

A `draft-conflict` from a tab that edited the draft in another tab therefore never reads as "your
message was sent", and a committed start whose response was lost never reads as "changed in another
tab" (#5512 thread 4177659608).

**Invariants.**
- **I1. One editable text per conversation.** Before a first send the words are the draft. During
  the flush the box is read-only (D10). During the send they are `sending.text`, which is not
  editable, and the box is empty. Afterwards they are the thread's first message, or back in the box.
  No moment has two editable copies, so no rule P is needed.
- **I2. The key is immutable**: `(orgId, anchor, conversationId)`. Only FORK (D18) re-keys, and
  only into a new key.
- **I3. Nothing evicts words.** Words leave only by D9 or D10b/D12 (sent), D19/D19L (gone, with
  nothing unsaved and nothing unacknowledged), D21 (discard), D15 "Use theirs", D16 "Let it go", or
  D25 (viewer change). No cap, timeout, storage failure, list refresh, remount or navigation removes
  them.
- **I4. The cache holds only unacknowledged words.** A key's `sessionStorage` item exists only while
  `local ≠ null` or `sending ≠ null`, and is removed on D8. A cache write that fails or would cross
  the 1,000,000-code-unit budget is not retried. The key is marked "this tab can't keep it either"
  (§7.4), and Elench never takes room from the canvas draft or the pending paid setup (G7).
- **I5. Unsaved edits are never overwritten** by a server row, a list refresh or another tab.
  Only the user's choice in D15/D16 replaces them.
- **I6. A stale editor update is never applied.** `epoch` changes only when the box is replaced
  from outside (D9, D10b, D11, D15, D16, D17b, D19, D22-with-change). An `EDIT` stamped with an older
  epoch is dropped. Typing during a refresh or a save is never dropped (G16).
- **I7. A stored turn id is never re-minted, and a stored turn is never sent from an unloaded
  transcript.** A committed start is loaded (D13, D17), and a send into a listed thread needs
  `transcript = loaded` (D9, D9a, D22). This is the half of turn identity drafts own (§5.3).
- **I8. Tenancy is the server's.** Drafts are keyed by the server-resolved org id. Every action
  compares it with the page's actor (§4 steps 2-3), and a page that no longer resolves answers a
  true refusal, never a throw the client retries.

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
| retrying, cache ok | "Not saved to your account yet. Kept in this tab. Retrying." Only for a transient failure (D27). |
| retrying, cache refused | "Not saved. This tab can't keep it either. Copy it before you close the tab." `beforeunload` asks for confirmation. |
| blocked: unauthorized | "Not saved: you are signed out. Sign in again in this tab to save it." |
| blocked: forbidden (`membership`) | "Not saved: you are no longer an active member of this organization. Copy your message; it is kept in this tab only." |
| blocked: forbidden (other) | "Not saved: you can no longer write here." |
| blocked: scope | D24 (`address` or `other-org`) |
| blocked: limit | "Not saved: you have 200 unsent messages here. Send or discard some to save this one." |
| blocked: too-large | "Not saved: this message is too long to save. It is kept in this tab only." |
| blocked: invalid / error | "Not saved: something went wrong saving this message. It is kept in this tab only." Reported to error tracking by field path only (§9). |
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

## 8. Org and account switches

### 8.1 The chat routes are #5515's

Revision 3 made both chat routes take a named org and resolve it "with `currentActor()`'s three-way
check". Review showed that function takes no argument (`lib/authz/guard.ts:27`) and that the
obvious resolver is unsafe in enterprise (`ee/src/scope.ts:87-94`; #5512 thread 4177659598). The
billing org of a chat turn is therefore #5515's, with the resolver it must specify. This ADR does
not change it. Drafts do not depend on it: every draft write is a server action whose tenant is the
page's org and is checked against the key (§4 steps 2-3), and a failed first send is retried through
`startConversation`, which is such an action. So a draft of org A is never saved, started or retried
under org B, whatever the session's active org is. A **later** turn's billing org stays the
session's, as on dev today, until #5515 lands.

### 8.2 Switches

- **Org switch in this tab**: D23. A's drafts stay on the server for A and are not shown in B.
- **Org switch in another tab**: no effect on this tab's draft actions. A server action's tenant is
  this tab's page (§1). (A chat turn's billing org is #5515, §8.1.)
- **Slug rename**: the action's `currentActor()` throws `notFound()`, which §4 step 2 turns into
  `scope-changed { reason: "address", slug }`, and D24 offers the new address in this tab. It is
  never a transient "Retrying" (#5512 thread 4177659600).
- **Slug reuse**: the key holds the org id, so a reused slug can never show A's words under B. The
  actor resolves to B, and §4 step 3 refuses with `scope-changed { reason: "other-org" }`.
- **Account switch or sign-out**: D25. Server drafts are A's, readable only under A's RLS scope.
- **Membership ends** (removed, or suspended through `setMemberSuspended`,
  `app/server/actions/members.ts:242`): `currentActor()` throws `notFound()` for the org's page
  (`org-scope.ts:112`), which §4 step 2 turns into `forbidden { reason: "membership" }`. The tab
  keeps the words and says so truthfully (§7.4); they are never retried. The server rows of that
  org are unreadable to the user and the sweep deletes them (§9). A suspended member who is
  reinstated within 30 days gets them back, because the sweep deletes only after the window.

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
  - drafts whose `(user_id, org_id)` has had no active `member` row for 30 days (measured from the
    draft's `updated_at`, so the rule needs no new column), except the personal org, where
    `org_id = user_id`.
- **On thread delete:** purged in the same transaction (§6.3).
- **On account delete:** `elench_drafts` is added to `ERASURE_RULES` as `erase` by `user_id`, next to `agent_threads` (`lib/privacy/erasure-plan.ts:118-127`).
  `tests/privacy/erasure-register-schema.test.ts` then checks the names against the schema.
- **Backups:** a purged draft remains in database backups until the backup retention expires. The
  privacy notice must say so. This is the residual cost the ruling accepts.
- **The tab:** `sessionStorage` holds a key's words only while the server has not acknowledged them
  (I4), and is cleared on a viewer change (D25).

## 10. Migration and rollout (via the db pipeline)

Three PRs. PR 1 holds `mutex:migration`, the board's single-migration lock
(`.claude/skills/db-pipeline/SKILL.md`).

**PR 1: server (needs Q1).**
1. Rebase onto `origin/dev`. Add `elenchDrafts` to `apps/console/lib/db/schema/agent.ts`, with the JSONB interfaces in
   `apps/console/types/jsonb.types.ts`.
2. Generate in one worktree only: `pnpm -F console db:generate` (`scripts/db-generate.sh` is
   lock-guarded), then `pnpm -F console check:migrations`. Do not edit the generated SQL by hand.
3. In `programmables.sql`: the `owner_only` AND policy, the two `SECURITY DEFINER` functions
   with `REVOKE … FROM PUBLIC`, and the grants to the app role. They are idempotent
   (`DROP POLICY IF EXISTS`, and `CREATE OR REPLACE` with an explicit `DROP FUNCTION IF EXISTS`
   if a return type ever changes; the 42P13 trap).
4. `app/server/actions/elench-drafts.ts` (§4, including the `notFound()` mapping of step 2 and the
   `thread` field of §4.2), `startConversation` (§5.1), and the purge in `deleteThread`.
   `createThread` keeps its signature for the project assistant's callers until PR 2.
5. **No chat route, no `use-agent-chat.ts` change.** Those are #5515's (§5.3, §8.1).
6. The sweep task, and the erasure register row.
7. Tests: an integration test, `tests/integration/elench-drafts-rls.test.ts`
   (`describeIfDb`). It checks that a member never reads another member's draft in the same org,
   that the org wall holds, that one user's same conversation id in two orgs is two rows (§3.2), and
   that the purge function never touches another user's rows. Action tests in
   `tests/actions/elench-drafts.test.ts`, including: a page path whose slug was renamed answers
   `scope-changed { reason: "address" }` with the new slug and writes nothing; a suspended member's
   page answers `forbidden { reason: "membership" }` and writes nothing; a `conflict` after a
   committed start names its `firstTurnId`, and a `conflict` from another tab's edit names none.
8. An `alethia-security-review` pass. It covers seam 3 (RLS, the new table, the SECURITY DEFINER
   functions), seam 2 (every action gated) and seam 1 (no secret persisted in a column that is
   surfaced or logged; drafts are not `execution_metadata`-like dumps, but they hold user-typed
   secrets).

**PR 2: the client store, the cache and the composer.** This adds `lib/stores/elench-drafts.ts`:
a pure `reduce(entry, event) → { entry, effects }`, the per-key queue, a cache adapter with a fake
that can refuse writes, and the selectors `useDraft(key)` and `useUnsent(scope)`.
- `ElenchComposer` seeds from the entry and reseeds on an `epoch` change.
- `useElenchSend` shrinks to dispatch.
- `pendingMentions` and the `beforeSend` staging stay until #5515 moves the routes to message
  metadata (§5.1).
- `newChat` mints a conversation id.

**PR 3: threads, the rail and notices (a `class:ui` draft PR; see Q3).**
- `useElenchThreads` resumes `activeKey[scope]`, catches `listThreads` and `loadInto` and renders
  the draft with an inline error and Retry (G10), and calls `listDrafts`.
- This PR adds the Unsent group, the footer status, the conflict bar, D9a's and D24's notices,
  the delete-confirm count, and `VIEWER_CHANGE`. D20's "Being answered" state ships with #5515.

**Rollout order.** PR 1 changes no request the client already makes, so it can deploy first.
`use-elench-store.ts:100` ("Flipping never remounts the chat") is corrected to "transcript" on the
way.

## 11. Cases: what the server model eliminates, and what still needs a transition and a test

**Sources:**
- #5464's 17 acceptance criteria;
- every inline thread, review body and advisory comment on #5423;
- all 21 inline gaps on #5512: G1-G11 from the first review (all resolved against revision 2) and
  G12-G21 from the second review;
- the six advisories in #5512's second review summary (A1-A6);
- the nine inline gaps on #5512 revision 3 (G22-G30, §11.5).

**Status:** **E** means eliminated by the server model: the mechanism that produced the case no
longer exists. **H** means handled: the case still applies, and a named transition with a test
covers it. **M** means moved to #5515 (turn idempotency): the case is about answering or billing a
turn, and this ADR keeps today's behaviour for it (§5.3).

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
| 7 | Org/account switch: A never seeds B; Retry never runs under B; a switch mid-load neither wedges nor writes A under B | H | D23, D24, D25, I8. A failed start's Retry is `startConversation`, an action in the page's org (§8.1). A **later** turn's billing org is #5515. | S › `org switch shows B's empty box and keeps A's failed start for A`; S › `scope change during listDrafts settles for the new scope only`; A › `startConversation from org B's page with A's key is scope-changed and stores nothing` |
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
| 33 | A failed `startThread` sent into `threadId: null`, and a committed-but-unattached row made Retry bill twice | 4173024467 | E | One transaction with a client-minted id; a lost response is loaded, never re-sent (D13, D17). Server-side exactly-once billing is **M** (#5515). | A › `a lost response then Retry answers already-stored`; S › `a lost created response: the next Enter loads the turn and sends nothing` |

### 11.3 #5512 inline gaps (G1-G11: first review, resolved on revision 2; G12-G21: second review)

| # | Gap (thread comment id) | St. | How the server model handles it | Test |
|---|---|---|---|---|
| G1 | A PK conflict returned the existing row, so a duplicated tab billed twice and erased the other tab's reply. Different turn ids were rewritten. `RECONCILE(listed)` left `thread=local`. (4177444315) | E | Compare-and-set on the draft serializes starts. The start-outcome table has no rewrite. `listDrafts` reports `listed`, and D22 loads the transcript. A second **answer** to one turn is **M** (#5515). | A › `two startConversation calls at one base: one created, one draft-conflict`; S › `duplicated tab: Retry in B after A's success loads A's transcript, and a further send from B keeps A's turns` |
| G2 | Nothing held the submitted text; mentions came through a global slot (4177444322) | E | D10 moves the words out of the box (I1). Mentions ride the message metadata (§5.1). | U › `the first turn is exactly the locked row's text`; R › `mentions are read from the last user message` |
| G3 | A persisted in-flight start had no exit; Discard during Starting; Undo; no timeout (4177444324) | E | `sending` is memory only, and the cache restores it as D11. Discard is draft-only. The 30 s timeout is D11, and a late commit surfaces through D17. | S › `reload during startConversation restores the words in the box, or the thread if it committed` |
| G4 | `SUBMIT_EXTERNAL` had no transition, and FORK dropped external text (4177444326) | E | D10x, D10y and D10z. On failure the prompt goes into the box (D11), and FORK carries it (D18). | U › `SUBMIT_EXTERNAL in every state` |
| G5 | I6 was client-only, and the route billed under the session org (4177444337) | M | #5515 (§8.1). Draft writes are org-checked actions (I8). | — (#5515) |
| G6 | A delete cleared one org's draft, and the confirm undercounted (4177444340) | H | §6.3: purge across orgs, pinned to the current owner, and count in the confirm | A › `purge removes the drafts in orgs A and B, and never another user's`; S › `the confirm counted two` |
| G7 | "Never evict" spent the origin's `sessionStorage` (4177444343) | E | The cache holds only unacknowledged words, within a budget, and refusing it never evicts (I4) | U › `at the budget a cache write is refused and a canvas-draft write still succeeds` |
| G8 | The unmount flush could write a sent message back (4177444345) | E | Writes come from the store's `local`, never from the editor. D10 bumps `epoch`, so a late editor update is dropped (I6). | S › `landing → first send succeeds → unmount → reload: the box is empty` |
| G9 | A sign-out other than the menu left secrets in the tab (4177444348) | H | D25 is raised by `useViewer()`, D26 sweeps other viewers' items, and the cache holds only unsaved words (I4) | S › `a session that ends without the menu clears the cache` |
| G10 | The LOAD-time `getThread` wedged the skeleton; the anchor change was not a scope change (4177444353) | H | PR 3 adds the catch, and the draft renders with an inline error and Retry. The anchor change is D23. | S › `getThread rejecting on load renders the draft with Retry`; S › `project and back restores each anchor's active conversation` |
| G11 | Traceability: no row for 4173024467, wrong citations (4177444357) | H | Row 33. This table cites every source by id. | review |
| G12 | The per-call `body` is dropped by `use-agent-chat.ts:61-63` (4177527031) | H | No draft path relies on the per-call `body`. The first turn's mentions are stored on its message (§5.1). Later turns keep the existing slot, as on dev, until #5515 changes the routes and the transport. | A › `the stored first turn carries its mentions` |
| G13 | `ALREADY_STORED` in a mounted tab left `useChat` empty, so the next Enter overwrote the row (4177527037) | H | D13, D17 and D22 always run `loadInto` and bump the lineage (D20 too, once #5515 lands). D9 needs `transcript = loaded`. §5.2 forbids an auto-send. | S › `B gets already-stored, the transcript shows A's turns, and B's next send keeps them in the row` |
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
| A2 | I6 named the billing org but did not check the project | M | #5515 (the hold is the route's). A project draft's own action already requires `authorizeQuiet("view", { type: "project", id })` in the page's org (§4 step 4). | A › `saveDraft for a project of another org is forbidden` |
| A3 | A stored first turn has no mentions | E | Mentions are stored in the first message's metadata (§5.1) | A › `the stored first turn carries its mentions` |
| A4 | An entry with `artifacts` and no words had no state name | E | States are not derived from content any more. An artifacts-only draft is an ordinary row, and D1 checks "no content". | U › `D1 with an artifacts-only draft mints a new key` |
| A5 | A stale tab can rebuild a conversation deleted more than a day ago | H | **The first-send path.** While the tombstone lives, `startConversation` answers `deleted`, and D18 forks to a new key. After the tombstone is reaped, a start from a stale draft creates a thread under the old id that holds only the first turn, read from the draft row, never the old transcript. **A stale tab's later turn** that carries the old transcript is transcript compare-and-set, **M** (#5515). | A › `a start after the tombstone is reaped stores only the first turn` |
| A6 | The count line said rows 18-46 | E | This table replaces it (§11.5) | — |

### 11.5 #5512 revision-3 inline gaps (G22-G30)

| # | Gap (thread comment id) | St. | How | Test |
|---|---|---|---|---|
| G22 | The turn claim refuses the HITL continuation, which is a second request for an answered user turn (4177659589) | M | #5515 case 7. This ADR adds no claim, so approvals work as on dev. | — (#5515) |
| G23 | The claim's global primary key collides across orgs under an org-scoped policy; `deleteThread` cannot remove it (4177659592) | M | The claim table is #5515 case 8. `elench_drafts` has no such collision: its unique key contains both policy columns (§3.2), and removal is the owner-pinned purge (§3.3, §6.3). | I › `one user's conversation C in orgs A and B is two rows, and both inserts succeed` |
| G24 | `maxDuration` bounds nothing under `output: "standalone"`; `agent.ts:121` is wrong (4177659595) | M | #5515's wrong-code facts. §1 states the fact; nothing here depends on a route duration. | — (#5515) |
| G25 | `currentActor()` cannot resolve a named org, and the enterprise fallback lands a removed member on their personal org (4177659598) | M | #5515's wrong-code facts. §8.1: drafts never use the route's billing org. | — (#5515) |
| G26 | A renamed slug or ended membership throws `notFound()`, which the client retried for ever as transient (4177659600) | H | §4 step 2 maps it to `scope-changed { reason: "address", slug }` or `forbidden { reason: "membership" }`; D24 and D28 never retry them; §7.4 says which. Other throws stop after three tries (D27). | A › `a renamed slug answers scope-changed with the new slug and writes nothing`; A › `a suspended member answers forbidden(membership) and writes nothing`; S › `after a rename the footer offers the new address, and following it in this tab saves the words` |
| G27 | D10 ignored the flush's outcome; a `draft-conflict` with no committed turn had no transition (4177659605) | H | D10/D10b/D10c: the start runs only after `saved` for exactly the content on screen, with the box read-only for the flush. D17b handles an uncommitted `draft-conflict`. | U › `every flush outcome × SUBMIT: only saved-for-the-shown-content starts`; S › `device B saves, device A presses Enter inside the debounce: nothing is sent and the conflict bar shows both texts` |
| G28 | D17's guard read a first-message id no outcome carried (4177659608) | H | Every refusal carries `thread: { status, firstTurnId }` from the same transaction (§4.2); the start table classifies by it. | A › `a conflict after a committed start names its firstTurnId; a conflict from another tab's edit names none`; S › `a lost created response, then the 30 s timeout: the card says the message was sent and no second send happens` |
| G29 | D19's list arm removed entries with unsaved words (`limit`, `too-large`, `forbidden`, retrying, a race with the first save) (4177659614) | H | D19L applies only to a key with nothing unsaved, nothing in flight, a server row seen, and no write answered after the list was requested. | U › property `no SERVER_ROWS removes an entry whose local ≠ null or whose server = null`; S › `New chat, type, focus inside the debounce: the words stay` |
| G30 | D22 set `listed` without loading the transcript, and D9 then sent from an empty `useChat` (4177659625) | H | D22 loads on a status change of a mounted key; D9 requires `transcript = loaded`; D9a loads instead of sending. | S › `device A starts K; on device B the refresh lands and B sends: the row holds A's turns followed by B's` |

### 11.6 Count

The table has 69 cases: 17 ACs, 16 #5423 review cases, 21 #5512 gaps from revisions 1-2, 6
advisories, and 9 revision-3 gaps. **33 are eliminated** by the server model (E), **30 are handled**
by a transition and a test (H), and **6 are moved** to #5515 (M: G5, A2, G22, G23, G24, G25).
Rows 33 and G1 are E for their draft half and name their billing half as #5515's.

## 12. Out of scope

- **Turn idempotency: #5515.** Answering and billing a turn exactly once, turn claims, a real
  duration bound on the chat routes, the HITL continuation, the chat routes' billing org and its
  resolver, regenerate semantics, and the switch of mentions from `body` to message metadata. §5.3
  is the interface drafts need from it.
- **Later turns that fail after hand-off** stay in the client transcript until `onFinish` saves
  them. That is server-side transcript saving (`lib/agent/thread-transcript.ts`), which #5464
  excludes.
- **A stale tab's later turn overwrites the transcript.** The routes save the client's
  `originalMessages` wholesale (`route.ts:282`, `:376-383`). Even a turn claim would not stop a tab
  with an old transcript from sending a **new** turn whose save replaces newer turns. The fix is a
  transcript revision checked by compare-and-set at save time, which is #5515 case 6. This design never **puts** a tab in that state itself (I7).
- Whether org-level threads should be org-scoped server-side (Q6).
- Lexical undo history across a remount, which is per mount.
- Real-time push of another device's edits. A tab learns at the moments in §6.4.

## 13. Open questions for the maintainer

Each has a recommended answer. Revision 3's questions about the claim lease (Q9), regenerate
billing (Q11) and transcript compare-and-set (Q8) moved to #5515 with the cases they belong to.

1. **Widen #5464's scope to the drafts server half.** That covers the `elench_drafts` table and its
   policy, the two owner-pinned functions, `app/server/actions/elench-drafts.ts`,
   `startConversation`, the `deleteThread` purge (in `app/server/actions/agent.ts`, which #5515 also
   names, so the two PRs are sequenced), the sweep and the erasure row. None of these are inside
   #5464's `scope:` globs today. No chat route and no `use-agent-chat.ts` change is in it.
   **Recommended: approve**, with PR 1 holding `mutex:migration` and an `alethia-security-review`
   pass.
2. **Retention of active drafts.** **Recommended: 30 days after the last edit**, and 24 h for
   discarded ones. A longer window keeps pasted secrets at rest for longer, and 30 days covers a
   holiday. A draft of an org the user is no longer an active member of follows the same 30 days,
   so a reinstated member gets it back (§8.2).
3. **The Unsent rail group, the footer status, the conflict bar and the D9a/D24 notices are new UI.**
   **Recommended: PR 3 is a `class:ui` draft PR**, per `.claude/COORDINATION.md`.
4. **Flush on tab close.** Server actions cannot use `keepalive`, and `sessionStorage` closes with
   the tab. **Recommended: accept** that a tab close can lose the edits since the last acknowledged
   save (§7.5): the save on `visibilitychange: hidden` covers most of them, and `beforeunload` asks
   when a key is already unsaved. The alternative is a `keepalive` route handler with its own CSRF
   and org checks, and a 64 KB body cap. Revisit it if telemetry shows real loss.
5. **Conflict default.** **Recommended: never auto-merge text.** Adopt silently only when the tab has
   no unsaved edits (D14, D22). Otherwise show Keep mine / Use theirs (D15).
6. **Org-level threads are user-scoped** (`agent.ts:97`), so one thread is listed in every org, with
   a draft per org. **Recommended: a separate issue** to make them org-scoped. §3.2 and §6.3 are
   correct either way.
7. **A paste that looks like a credential.** **Recommended: show a one-line inline notice the
   first time per draft**: "Drafts are saved to your account. Avoid pasting credentials." Do not
   block or redact. Detection is client-side and best-effort, and the notice must not claim more.
8. **The 200-draft limit per scope.** **Recommended: 200.** It refuses new rows only, never
   evicts, and says so.
9. **The 30 s start timeout** (D11). **Recommended: 30 s.** A late commit is safe, because the
   failed-start save's conflict names the committed `firstTurnId` and the start table sends it to
   D17.
10. **A read-only box during the pre-send flush** (D10). **Recommended: accept.** It lasts one save
    round trip, and it is what makes "the start sends exactly what the box showed" true without a
    second copy of the words. The alternative, letting the user type and diffing afterwards, is
    rule P again.
11. **A slug rename offers the new address in this tab** (D24). **Recommended: accept.** A reload
    of the old address is a 404, and the unsaved words live in this tab's `sessionStorage`, so the
    only exit that keeps them is navigating in the same tab. The action returns the new slug only to
    a caller who is still an active member of that org (§4 step 2).
