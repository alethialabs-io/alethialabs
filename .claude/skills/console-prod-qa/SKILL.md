---
name: console-prod-qa
description: Drive the maintainer's own Chrome over the production console at alethialabs.io and report what is actually broken — a witnessed pass, not a test suite. Use when the maintainer says "open Chrome on alethialabs.io and test everything", "run the prod QA pass", "QA production after the deploy", or "take the B2 golden path on <cloud>". It creates real rows in one QA organization and sends one real email — and its golden-path mode signs up a fresh account and deploys a real cluster on the maintainer's card — so it is never model-invoked.
argument-hint: "full | routes | journeys | destructive | report-only [--allow-jobs] | golden-path <aws|gcp|azure|hetzner> --allow-jobs"
disable-model-invocation: true
license: AGPL-3.0-only
---

# The production QA pass

This is the **last** layer of the release gate and the only one with no simulation in it.
Playwright in Actions proves the build behaves against a seeded database; this proves the
**production configuration** behaves — the real Stripe keys, the real OAuth redirect URIs, the
real email sender, the real DNS, the real object storage, the real entitlement resolution — in
the maintainer's own browser, with the maintainer watching.

It is `disable-model-invocation: true` **because it mutates production.** A session that has
started reasoning about QA must not find this and run it; the maintainer names it. Everything it
creates is reversible and lives in one organization, and it still sends one real email to one
real inbox. That is why the preconditions below are refusals rather than warnings.

**What it is not.** It is not a substitute for a failing CI leg — a red gate leg is cheaper to
read and fix. It is not a way to find *layout* regressions; the audit leg scores those against a
rubric and does it better. And it does not measure the signed-out surface: layers 1 and 2 own
that, and this run reports it `NOT MEASURED by design` rather than re-deriving it worse.

**The golden-path mode is a different run with a different subject.** `golden-path <cloud>
--allow-jobs` (§7) does not sweep the QA organization at all: it takes predicate **B2** of
`docs/beta/README.md` — a fresh account signs up, connects a cloud, designs, deploys, sees the
cluster running and destroys it — on one cloud, and writes one evidence record that
`scripts/programme-rollup.mjs` reads. §0–§6 below are the sweep; §7 is the golden path, and it
states which of §0–§6 it reuses rather than inheriting them silently.

Read `.claude/skills/dev/SKILL.md` if you find yourself wanting a runtime. You do not want one
here — this pass has exactly one target and it is production.

---

## 0 · Preconditions — each one is a hard refusal

Run these **in order**, before opening a single page. A refusal means: say which precondition
failed, say what would fix it, and **stop**. Do not proceed on a partial answer, and never
attempt a remedy that changes production state (no signing out, no switching organization, no
accepting a consent banner on the maintainer's behalf).

1. **Load the browser tools in one call.** Invoke the harness `claude-in-chrome` skill, then
   fetch every tool you will need in a **single** `ToolSearch` — the core set plus
   `get_page_text`, `find`, `read_console_messages`, `read_network_requests`, `javascript_tool`,
   `form_input`, `resize_window`. One call per tool wastes a round-trip each; there will be
   hundreds of steps after this.
2. **Resolve the route manifest.** `node scripts/lib/console-routes.mjs --json`. A **raise is a
   refusal** — that script fails rather than reporting a short list, and a truncated manifest
   would silently narrow the sweep to whatever it happened to read. Record `version` and the
   route count; if `version` is not one this file knows (1), stop.
3. **Read the destructive-action registry.** `apps/console/destructive-actions.yaml`. Refuse on
   an unknown `version`, and refuse if **any** entry lacks a `prod-qa` field — an unclassified
   destructive control is one nobody has decided about, and guessing is how a QA pass deletes
   something. Tally the three values and carry the tally into the report.
4. **Read the identity allowlist.** `.claude/skills/console-prod-qa/allowlist.yaml`. It holds
   **SHA-256 digests, never plaintext** — this repository is public, and a QA email and org slug
   are exactly the two strings an attacker would want. Refuse if either digest is absent or still
   the placeholder.
5. **Verify the identity, by hash.** Read `/api/auth/get-session` and the slug the `/dashboard`
   landing resolves to. SHA-256 each, compare against the allowlist. On a mismatch: say **which
   one** mismatched (email, or org), and stop. **Never sign out and never switch organization to
   make it match** — you would be QA-ing an account nobody authorised, and a sign-out ends the
   maintainer's own session. When the allowlist sets `host`, the page's host must equal it: a
   session cookie copied onto a staging or branch host otherwise passes both digest checks while
   measuring something that is not production.
6. **Verify telemetry is off.** The `alethia_consent_v2` cookie must record analytics as
   rejected **and** the network log must show zero PostHog requests. Both halves: the cookie says
   what was chosen, the network says what happened, and a QA pass that pollutes product analytics
   with synthetic funnels corrupts the numbers the business reads.
7. **`gh auth status`** — the run files issues at the end. Discovering a missing token after two
   hours of measurement loses the findings.
8. **Mint the run id**: `qa-<yyyymmdd>-<hhmm>`, UTC. Every resource this run creates is named
   `qa-<run-id>-…` so a leftover is identifiable months later by anyone.
9. **Record the build under test**: `window.__ENV.NEXT_PUBLIC_APP_VERSION`. A report that does
   not name the build it measured cannot be compared to the next one, and cannot be matched to a
   deploy.

---

## 1 · Blast radius

**Allowed:** reversible mutations, in the QA organization only, every created resource named
`qa-<run-id>-…`.

**Open-assert-Cancel** for every registry entry marked `open-cancel`: open the control, assert the
confirmation it declares (`confirm`, `confirm_action`, `dialog_title`), press **Cancel**, and
prove nothing changed. A registry entry marked `own-rows-only` may be confirmed, but **only on a
row this run created** — never on one that was already there.

**Forbidden, without exception:**

- the canvas **Deploy** action, and the **Run** menu — unless `--allow-jobs` was passed *and*
  the QA org has zero connected cloud identities, which is the only state in which a job cannot
  spend money. The golden-path mode is the one other exception, and §7 bounds it: one floor-sized
  deploy, in the fresh org that run created, after the maintainer's go
- **confirming Destroy environment**, **Cancel plan**, **Remove card**, **Delete organization**
  or **Delete account** — each is either irreversible or destroys the QA org this pass needs.
  Four of the five are `prod-qa: skip`, so their dialogs are never opened either. The fifth,
  `env.destroy`, is `prod-qa: open-cancel` *by decision*: opening its dialog and pressing
  **Cancel** is the measurement this pass exists to take. So this bullet says **confirming**
  rather than *reaching* — it is the confirm button that is forbidden, and `skip` is what
  forbids the reach
- **any member row this run did not itself invite**
- **anything on the admin surface** — it is not this run's subject and its blast radius is every
  tenant
- **any submit that would email anyone but the QA `+alias`**, and **any OTP send**
- **more than one invitation per run** — one proves the flow; a second only adds a leftover

Anything a registry entry marks `skip` is not touched on production, and the report repeats the
`reason` beside it rather than re-deciding it.

---

## 2 · `javascript_tool` is a measuring instrument, not a hand

Five read-only snippets are allowed. Nothing else — no clicking through script, no state
mutation, no `fetch` that writes. A measurement that changes what it measures is not a
measurement, and a script that clicks is a click nobody can see in the transcript.

1. **Horizontal overflow** — `documentElement.scrollWidth` against `clientWidth`.
2. **`h1` census** — the count and text of `h1` elements on the page.
3. **Enabled-control list** — every enabled `button`, `a[href]`, `[role=button]`,
   `[role=menuitem]`, `input`, `select` with its accessible name.
4. **Overlay hit-test** — `elementFromPoint` at the overlay's centre *and* four inset corners.
   Centre alone passes an overlay that is clipped on one side, which is the defect shape that
   matters.
5. **Cookie + build read** — `alethia_consent_v2` and `window.__ENV.NEXT_PUBLIC_APP_VERSION`.

**Never trigger `alert`, `confirm` or `prompt`.** A browser modal blocks every subsequent
extension command; the session goes dead and only the maintainer can clear it by hand.

---

## 3 · The phases

`full` runs 0 → 6. `routes` runs 0, 2, 5, 6. `journeys` runs 0, 3, 5, 6. `destructive` runs 0, 4,
5, 6. `report-only` runs 6 against the notes of a run already taken. `golden-path` runs none of
them: it runs §7, and only §7.

### Phase 0 · Baseline snapshot

Before touching anything: the QA org's projects, environments, connectors, alert channels and
policies, members and pending invitations, runners, and the artifact/thread/knowledge lists.
Phase 5 diffs against this. Without a before-snapshot, "nothing leaked" is an assertion rather
than a measurement.

### Phase 1 · The signed-out surface — `NOT MEASURED by design`

Marketing, sign-in, invite-acceptance and the public pages are owned by the Playwright layers.
Record the reason; do not measure them.

### Phase 2 · The route sweep

Every route from the manifest whose params this run can bind. Per route:

- it **loads** — no error boundary, no infinite skeleton
- **one** `h1`, or none plus a breadcrumb that names the page (the console has no page titles —
  `CLAUDE.md` §6 is the rule this checks)
- **zero console errors**, and **zero same-origin responses ≥ 400**
- an empty list renders an **empty state**, not a skeleton that never resolves
- **every enabled non-destructive control activates something** within a second — this is the
  live half of the same question the audit rubric asks statically
- the **first two overlays of each kind** hit-test above the page chrome
- **no horizontal overflow** at 1280 and at 768
- a plan-gated page renders the upsell rather than a blank or a crash

A route whose params cannot be bound is `NOT MEASURED`, with the missing param named.

### Phase 3 · Journeys

In order, and each one stops at the first hard failure rather than pressing on:

a. project create → b. canvas author and **save without deploying** → c. environment create →
d. connectors: open each sheet, submit **invalid** input, read the error → e. alert channel and
policy → f. classification → g. roles → h. teams → i. **one** invitation, then the duplicate
refusal, then cancel it → j. the support form to step 5, then `NOT MEASURED` (submitting mails a
human) → k. billing dialogs opened and cancelled — **except the two the registry marks `skip`**,
`billing.card.remove` and `billing.subscription.cancel`, which §1 also names in its own forbidden
list and which are `forbidden by blast radius` here too → l. all fifteen filter surfaces:
URL round-trip, facet counts that do not move when a facet is picked, debounced search.

Then the cross-cutting set: `⌘K`, theme switch, Ask AI, the setup guide, the CLI download,
notifications, feedback, the account dialog — including its **Request deletion** button, which
is **recorded from the registry, not clicked** (`account.delete` is `prod-qa: skip`): confirming it
opens a real erasure request about the QA account that a person then acts on, and pressing it
without confirming still leaves the dialog one click from that.

### Phase 4 · The destructive sweep

Driven **from the registry, never from the page**. For each entry **whose `prod-qa` is not
`skip`**, in registry order: reach the control by its `reach` and `control`, assert the declared
confirmation, then Cancel. An entry whose `status` is `missing` **must fire on a bare click** —
if a dialog now appears, that is a finding: the registry is stale and the lane that added the
dialog did not flip the entry.

**That clause is the safety of this phase, not a refinement of it.** §1 says an entry marked
`skip` is not touched on production, and a reader executes *this* paragraph. Without the clause it
sweeps every `skip` entry too — **24 of the 47 controls** the registry carried on 2026-09-09 —
and **11 of those 24 are `status: missing`**, so the bare-click rule fires them: among them
`billing.subscription.cancel`, which cancels the QA org's real subscription, and `members.suspend`,
which cuts off a real person. Phase 5 cannot undo either — teardown deletes the `qa-<run-id>-…`
rows this run created, and neither of those is one. A `skip` entry is **recorded from the
registry**, with its `reason` and `forbidden by blast radius`, and never opened; that is how the
sweep still accounts for every entry without touching that half of them.

**The bare click still obeys `own-rows-only`.** `prod-qa` has three values, so every entry the
clause admits is `own-rows-only` or `open-cancel` — and on a `missing` entry the bare click *is*
the mutation, with no dialog in front of it. Fire it **only on a `qa-<run-id>-…` row this run
itself created**, never on one that was already there. Eight entries are `missing / own-rows-only`
today, four of them over threads, artifacts, knowledge and widgets and three over real members,
invitations and team memberships, and this sentence is the only thing standing between them and a
row somebody else owns. Where an `own-rows-only` entry's subject is **not** a row this run can
create — `org.logo.remove` acts on the QA org itself — it is `forbidden by blast radius` and a
**testability gap** for §4's report, not a bare click to attempt anyway.

**An absent `reach` is not a refusal.** `reach` is the optional opener chain walked *first*; an
entry without one puts its control on the `route` itself, which is exactly how
`apps/console/e2e/audit/destructive.spec.ts` reads it. Go to `route` and match `control`. Refuse,
as `instrument refused`, only when the control cannot be found — or when it matches more than once
after the chain has run, since an ambiguous match attributes a verdict to a control you did not
identify. One non-`skip` entry (`runners.remove`) has no `reach` today.

### Phase 5 · Teardown and the empty diff

Delete every `qa-<run-id>-…` resource this run created, in reverse creation order. Re-snapshot
and diff against Phase 0. **The diff must be empty.** A non-empty diff is a leftover and goes in
the report by name — never silently retried, because a delete that failed twice is a defect worth
more than a clean report.

### Phase 6 · Report and issues

---

## 4 · The report

`apps/console/docs/qa/prod-runs/<date>-<time>.md`, with these headings and in this order:

1. **Header** — run id, build version, UTC start and end, and the identity **as hashes only**
2. **Verdict counts** — PASS / FAIL / NOT MEASURED, per phase
3. **Routes**
4. **Journeys**
5. **Destructive sweep**
6. **Defects** — each with the issue number filed for it
7. **Leftovers** — empty is the expected value, and saying so is the point
8. **What this run could NOT measure**, each with a reason from the fixed vocabulary:
   `by design` · `param unbindable` · `plan-gated` · `forbidden by blast radius` ·
   `blocked by an earlier failure` · `instrument refused`
9. **Testability gaps** — a control this pass could not name or could not reach. These are the
   findings that make the *next* run cheaper, so they are a section rather than a footnote.

A golden-path run (§7) writes a different file: an **evidence record**, front matter first, through
`b2-record.mjs`. The sweep report above has no front matter, which is how the rollup tells the two
apart — a sweep report is not a record and is never read as one.

Screenshots stay in the scratchpad and are **not** committed. A report is prose plus verdicts;
a directory of PNGs is neither reviewable nor diffable, and it would grow the repo every run.

`apps/console/docs/qa/README.md` says where this sits among the QA documents;
`apps/console/docs/qa/findings.md` is the standing findings ledger and
`apps/console/docs/qa/coverage-matrix.md` the coverage view. This run appends to neither — it
writes its own dated file, and a later change reconciles them.

---

## 5 · Filing issues

Title `[prod-qa] <route>: <symptom>`. Labels `qa:prod` and `bug`.

**Dedupe by exact title** over `gh issue list --label qa:prod --state all --json title`. Not
`--search`: search is fuzzy and eventually consistent, so it both misses a duplicate filed
minutes ago and matches an unrelated issue — and a QA pass that files forty duplicates is a QA
pass nobody reads again.

One issue per symptom, not per occurrence. Ten routes with one broken shared control is one
issue naming ten routes.

---

## 6 · Stop conditions

- **two consecutive failures on one control**, or **three within a phase** → stop, mark the rest
  of that phase `NOT MEASURED` with `blocked by an earlier failure`, and ask the maintainer
- **any precondition in §0 failing**, at any point — they are re-checked, not assumed
- **a browser modal appears** → stop; only the maintainer can dismiss it
- **the identity changes mid-run** → stop immediately; a session that switched org is measuring
  something else
- **anything ambiguous about blast radius** → stop and ask. The cost of asking is one message;
  the cost of guessing is a production row nobody can un-create.

---

## 7 · The golden path — `golden-path <cloud> --allow-jobs` (predicate B2)

**What it measures.** Predicate **B2** of `docs/beta/README.md`, on **one** cloud: one person,
starting from a **new account on production**, signs up, connects a cloud account, designs a
project, deploys it, sees the cluster running, and destroys it. B2 is true for a cloud only when
the newest B2 record for that cloud says `pass`, from a fresh account, with all six steps, dated
within 31 days, on a build that is on `main`. Four clouds means **four runs** — one invocation per
cloud, each from its own fresh account, each writing its own record. There is no `all`: a record
names one cloud, and a run that tried four in one sitting would leave three clusters standing while
it worked on the fourth.

**Why it spends, and how much.** Unlike the sweep, this run deploys a real cluster into the
maintainer's own cloud account, on the maintainer's card. The spec budgets it as *a floor-sized
cluster for under an hour*, per cloud, about twice before the beta. `.claude/hooks/guard-spend.sh`
prices Bash commands and cannot see a browser click, so this section **is** the meter: the bounds
in G·1 are refusals, not guidelines.

### G·0 · Preconditions — each one is a hard refusal

Same rule as §0: say which failed, what would fix it, and stop. **No precondition failure writes a
record** — nothing was observed, and a record that says so would shadow an older pass for that cloud.

1. **`--allow-jobs` was passed, and `<cloud>` is one of the schema's four** (`aws`, `gcp`, `azure`,
   `hetzner` — `docs/beta/evidence-schema.json`'s cloud enum is the list; read it, do not trust this
   sentence). Without `--allow-jobs`, refuse: the step that makes B2 worth recording is the deploy.
2. **The record writer passes its self-test**:
   `node .claude/skills/console-prod-qa/b2-record.mjs --self-test`. It proves, against the tree you
   are standing in, that the record this run will write is one `scripts/programme-rollup.mjs`
   accepts. Finding out it is not, after an hour of production and a destroyed cluster, loses the
   observation for good.
3. **Load the browser tools in one call** — §0 step 1, unchanged.
4. **The identity allowlist carries `golden_path_mailbox_sha256`**
   (`.claude/skills/console-prod-qa/allowlist.yaml`), and `host`. Refuse on an empty or placeholder
   digest, as §0 step 4 does for the other two.
5. **The browser holds no Alethia session.** Read `/api/auth/get-session` on the allowlisted
   `host`: it must return no user. The maintainer opens a Chrome profile with no `alethialabs.io`
   session for this — **never sign anyone out to get there**; a sign-out ends a session somebody
   chose to keep. This is also the first half of `freshAccount`: an account cannot be fresh if the
   run started inside one.
6. **Telemetry is off** — §0 step 6, both halves. A clean profile shows the consent banner:
   the **maintainer** rejects analytics; never answer it on their behalf.
7. **The build is on `main`, as a full SHA.** Read `window.__ENV.NEXT_PUBLIC_APP_VERSION` (§2
   snippet 5). Then `git fetch origin main` and `git merge-base --is-ancestor <sha> origin/main`.
   It must be 40 hex characters and the ancestry check must exit 0. B2 counts only a build that is on
   `main`; a run on any other build spends money on an observation that can never count.
8. **`gh auth status`** — §0 step 7.
9. **Mint the run id** `qa-<yyyymmdd>-<hhmm>` (UTC), and check that
   `apps/console/docs/qa/prod-runs/<yyyy-mm-dd>-<hhmm>.md` does not exist. A record is never
   overwritten; if the minute is taken, wait for the next one.

### G·1 · Blast radius

**Allowed, and only in this mode:**

- **one** sign-up, and the **one** sign-in code it mails, to `<mailbox>+qa-<run-id>-<cloud>@<domain>`
  — the maintainer's own QA mailbox, tagged with this run. The **maintainer** types the address and
  the code; the agent never reads the mailbox and never writes either string anywhere
- **one** organization, named `qa-<run-id>-<cloud>` where the form lets you choose
- **one** cloud connection, which the **maintainer** completes in the provider's own console
  (credentials, a trust role, a CloudShell paste). The agent never types, reads or relays a
  credential, a key, a token or a role ARN into any file
- **one** project and **one** environment, from the **smallest** configuration the canvas offers for
  `<cloud>` with **no add-ons** — the floor, not the full bar. If the canvas shows a cost estimate,
  record it; if it shows more than the floor, stop and ask
- **one** Deploy, pressed only after the maintainer says **go** in the conversation. Pressing Deploy
  starts the spend; that is the maintainer's decision, every time
- **confirming Destroy environment on that one environment** — the confirm §1 forbids. It is
  allowed here because the environment is this run's own, and because destroying it is what ends the
  spend. It needs no go: the run is always allowed to stop spending
- if the fresh org must pick a plan before it can deploy, the **maintainer** does it by hand. The
  agent never types or reads payment details, and never opens a checkout on its own

**Still forbidden, without exception:** everything in §1 that this list does not name — any org but
the fresh one, the allowlisted QA org included; any second sign-up, invitation, OTP or email; the
admin surface; the **Run** menu; any Deploy after the first; **Delete organization** and **Delete
account**, whose dialogs are not opened (the account outlives the run, by design: deleting it is an
erasure request a person acts on).

**The clock.** At most **60 minutes from the Deploy press to Destroy confirmed.** If the cluster is not
running at minute 45, `running-cluster` is a FAIL: record it and destroy now. Destroy the moment
`running-cluster` is observed — there is nothing else to measure on it.

### G·2 · The six steps

In order. Each step stops at its first hard failure. A **product** failure at any step still
destroys whatever this run deployed (G·3), then writes a `fail` record. The step names are the
schema's vocabulary exactly, and the record lists the ones that **completed**, in this order:

1. **`sign-up`** — the sign-up page on `host`, the tagged address, the code, the onboarding until the
   console shell renders. Then verify, **by hash**: SHA-256 of the session email with its `+tag`
   removed equals `golden_path_mailbox_sha256`; the tag is exactly `qa-<run-id>-<cloud>`; and the
   user's `createdAt` is after the run started. All three together, plus G·0 step 5, are what
   `freshAccount: true` means. Any one missing is `freshAccount: false`, and a record with that can
   never pass — say so and stop before connecting a cloud. Record the email and slug **as SHA-256
   only**.
2. **`connect`** — the connectors page, `<cloud>`, the maintainer completes the provider side. Pass
   when the console shows the connection verified. Record which flow it was (keyless, CloudShell,
   key) and the elapsed time.
3. **`design`** — a project, a canvas from the floor configuration for `<cloud>`, saved. Pass when the
   save is confirmed and a reload shows it.
4. **`deploy`** — an environment, then Deploy, after the maintainer's go. Pass when the deploy job
   reaches success. Record the job id (not its URL), its duration, and the runner that claimed it — its
   name and operator as the job page shows them. REL-L18's managed-runner records are taken during
   this same run and cite this one.
5. **`running-cluster`** — the environment page shows the cluster running, and its health reads
   healthy. Pass on what the console shows, observed — not on the deploy job's own success.
6. **`destroy`** — Destroy environment, confirmed. Pass when the destroy job succeeds **and** the
   environment page shows nothing left standing.

Phase 2's per-page checks still apply on each page the path crosses — zero console errors, zero
same-origin responses ≥ 400. A failure there is a defect to file (§5), but not a failed step unless it
stopped the step.

### G·3 · Teardown, and the leftover that matters

**Destroy runs on every exit after the Deploy press** — a pass, a failed step, a stop condition, a
maintainer's stop — before anything else, including the record. If Destroy itself fails: say so to
the maintainer **at once**, with the cloud, the environment and the job id, retry **once**, and on a
second failure stop — the maintainer clears it from the provider's console. That is a `fail` record
with `destroy` absent from `steps`, and it heads **Leftovers**.

Then remove the cloud connection from the fresh org (its own row). The provider-side trust the
maintainer created stays the maintainer's to remove; Leftovers names it, so it is not forgotten.

### G·4 · The record

**One run writes exactly one file**, `apps/console/docs/qa/prod-runs/<yyyy-mm-dd>-<hhmm>.md` — the
run id's minute — and that file **is** the B2 evidence record: SPDX comment, YAML front matter that
validates against `docs/beta/evidence-schema.json`, then the prose. It is written by the writer,
**never by hand**:

```
node .claude/skills/console-prod-qa/b2-record.mjs write \
  --run-id <run id> --cloud <cloud> --build-sha <40-hex sha> \
  --verdict <pass|fail|not-measured> --fresh-account <true|false> \
  --steps <completed steps, comma-separated, in order> \
  --observer <maintainer|agent> --body <scratchpad prose file>
node .claude/skills/console-prod-qa/b2-record.mjs check
```

The writer refuses rather than writes when the record would not validate, when the file exists, when
`steps` skips one, when a pass lacks a step or a fresh account, and when the prose contains an email
address. `check` runs the same rules over every record already in the directory; run it after
writing, and do not commit on a refusal.

**The verdict:**

- **`pass`** — all six steps completed, `freshAccount: true`, nothing left standing.
- **`fail`** — a step failed because the **product** failed. `steps` lists the ones before it. A
  failure is always recorded: hiding it behind a later attempt is the one thing this record exists
  to prevent.
- **`not-measured`** — the run stopped after the Deploy press for a reason that is **not** the
  product's (instrument refused, a browser modal, the maintainer stopped it). A stop **before** the
  Deploy press writes no record and spent nothing; the stop is reported in the conversation.

`evidence` is the record's own path — its prose is the step-by-step account — and the writer adds it.
Job ids go in the prose. Console URLs do not: they carry the fresh org's slug, which the record holds
as a digest.

**The prose** (`--body`), with these headings in this order:

1. **Header** — run id, cloud, build SHA, host, UTC start and end, mode, the identity as SHA-256 only
   (mailbox base, and org slug), the runner that claimed the deploy
2. **Steps** — one entry per step of G·2: PASS / FAIL / NOT MEASURED, the time it took, what was seen
3. **Spend** — the configuration deployed, the cost estimate if the canvas showed one, and the minutes
   from Deploy press to Destroy confirmed
4. **Defects** — each with the issue number filed for it (§5)
5. **Leftovers** — the cloud side must be empty; the fresh account and org, and the provider-side
   trust, are named as expected leftovers
6. **What this run could NOT measure** — §4's closed vocabulary

Then add the run to `apps/console/docs/qa/prod-runs/README.md`'s index, open a PR into `dev` with the
record, and say which clouds still lack a B2 pass inside the window.

### G·5 · Stop conditions

§6's, plus three of its own. Each one destroys first (G·3) if Deploy was pressed:

- **the clock**: 60 minutes since the Deploy press
- **anything that would deploy a second time** — a retry button, a re-run, a second environment
- **a cost estimate above the floor**, or a configuration the run did not choose
