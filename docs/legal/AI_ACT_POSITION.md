<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# AI Act position

**Status: Draft — pending maintainer legal review (#7351).** Written by an agent for LEG-L4 (#6922).
No lawyer has reviewed it, and it is not legal advice. Where it reads the Regulation, it says so.
Those readings are the points the maintainer has to confirm.

Owner: LEG-L4 (#6922)

Effective: 2026-11-23

This document states how Regulation (EU) 2024/1689 (the AI Act) applies to Alethia's hosted service.
It covers two things the issue names: outside agents that apply changes, and repository content sent
to the model provider. The public page at `/ai-transparency`
(`apps/marketing/app/ai-transparency/page.tsx`) is written to say the same. §7 lists, line by line,
where the page and this document agree.

The code already states a classification, in `AI_SYSTEM_CLASSIFICATION` in
`apps/console/lib/ai/transparency.ts`, and `GDPR_ACCOUNTABILITY.md` repeats it. This document checks
that classification against the code and records the points where the code does not bear it out.

## 1. Position in short

- Alethia puts an AI assistant into service under its own name. The assistant is built on
  general-purpose models from a third party: Anthropic by default (`apps/console/lib/config/ai.ts`).
- The assistant is not a high-risk system under Annex III, **as long as** a person approves every
  change it proposes. That holds today for Alethia's own assistant (§4).
- The art. 50 transparency duties apply. The text that discharges art. 50(1) exists
  (`AI_SYSTEM_DISCLOSURE`), but no console screen renders it (§5). That is the main gap.
- Repository content is sent to the model provider when a user imports a repository. That path does
  not go through the evidence gate that switches the assistant's chat off (§3). That is the second gap.
- Outside agents (a customer's own coding agent, over MCP or the CLI) are AI systems the customer
  deploys, not Alethia. Over MCP they can only read today. Second-person approval for applies made by
  connected agents is part of the beta programme. Until it ships, an agent acts within the deploy and
  destroy permissions of the account or token it uses (§4).

## 2. Alethia's role

`AI_SYSTEM_CLASSIFICATION.role` says: "Deployer of a general-purpose AI model, embedded as an
assistant."

My reading of art. 3 points (3) and (4):

- A **provider** is whoever develops an AI system, or has one developed, and places it on the market
  or puts it into service under its own name.
- A **deployer** is whoever uses an AI system under its own authority.

Alethia builds the assistant (prompts, tools, routes) and offers it to customers under the Alethia
name. On that reading, Alethia is the **provider of the AI system**. Anthropic is the provider of the
general-purpose AI model inside it. The customer and its users are deployers when they use the
assistant in their work.

Most of what follows does not depend on the label: art. 50(1) and 50(2) bind providers, so the
"provider" reading puts them on Alethia directly. **Open: maintainer to confirm** the role, then
correct `AI_SYSTEM_CLASSIFICATION.role` and the matching sentence in `GDPR_ACCOUNTABILITY.md`. Neither
file is in this unit's scope.

The obligations on providers of general-purpose AI models (art. 53 onward) fall on Anthropic, not on
Alethia, as long as Alethia does not train or modify the model. Nothing in the repository trains or
fine-tunes a model.

## 3. What is sent to the model provider

### 3.1 Conversations with the assistant

The chat routes are the console agent (`app/api/agent/route.ts`, `app/api/agent/[agentId]/route.ts`),
the project assistant (`app/api/projects/[projectId]/assistant/route.ts`) and support ask
(`app/api/support/ask/route.ts`). All of them go through `readTurnRequest` in
`apps/console/lib/agent/turn-route.ts`. It answers 503 unless `isAiConfigured()` is true. They send:

- what the user typed or pasted, which can include code and secrets;
- for a project chat, a "project knowledge" block derived from live state: the project's identity,
  its environments and its last five jobs, capped at 2000 characters
  (`apps/console/lib/ai/project-knowledge.ts`);
- results of the tools the model calls. Each tool that reads account data runs as the user, through
  the same permission checks as the console (`apps/console/lib/ai/TOOLS.md`).

### 3.2 Repository scans

When a user imports a repository, a runner clones it and builds a digest without executing any code
(`packages/core/scanner/scanner.go`). The digest holds the full text of these files:

- package manifests (`package.json`, `go.mod`, `requirements.txt`, `pyproject.toml`, `Pipfile`,
  `Gemfile`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `Cargo.toml`, `composer.json`, `mix.exs`);
- Dockerfiles; compose files; Kubernetes manifests;
- CI and platform files (`.github/workflows/*.yml`, `.gitlab-ci.yml`, `Procfile`, `fly.toml`,
  `vercel.json`, `render.yaml`, `app.yaml`, `nixpacks.toml`);
- environment templates (`.env.example`, `.env.sample`, `.env.template`, `.env.dist`).

There are limits: each file up to 64 KiB, 25 files per kind, 20,000 files walked. Dependency and build
directories such as `node_modules`, `vendor` and `.git` are skipped.

The console then sends the digest to the model. `inferStack` in `apps/console/lib/scanner/infer.ts`
sends up to 120,000 characters of it, with a system prompt that tells the model to treat the content
as untrusted data and not as instructions. Two call sites do this: `readScanProposal`
(`apps/console/lib/rpc/procedures/projects.ts`) and `getMergedScanProposal`
(`apps/console/app/server/actions/scanner.ts`). The digest also stays in the job row
(`jobs.execution_metadata.repo_digest`). `RETENTION_SCHEDULE.md` §4 finds no period for that row.

**The gap.** Neither scan call site, nor `queueRepoScan`, nor `inferStack` calls `isAiConfigured()`
or `providerGate()`. `getAiModel()` builds the model client without asking. So a repository scan sends
file contents to the provider whenever an API key is set, even if the four evidence values (DPA,
transfer mechanism, retention, no-training) are missing. Those values switch the chat off.
`GDPR_ACCOUNTABILITY.md` says the assistant "fails closed until they are" recorded. That is true of
the chat routes and not of the scan.

Repository files can hold personal data (names and emails in manifests and CI files). A template
meant for example values can also hold a real secret by mistake. Alethia has no control over what a
customer commits.

**Recommended fix (outside this unit's scope).** Check `isAiConfigured()` in `queueRepoScan` before a
scan is queued, and in `inferStack` before the call. Refuse with `aiDisabledReason()`, the same way
the chat routes do. Until that lands, the public page says plainly that a repository import sends
these files (§7).

### 3.3 What is not sent

- Cloud credentials. The model never receives them (`AI_SYSTEM_DISCLOSURE.limitations`). No tool
  reaches the kubeconfig mint: `registry.ts` denies it, and
  `tests/kubeconfig-mint/ai-tool-denylist.test.ts` checks that.
- Product analytics. Prompts and outputs are not forwarded (`captureAiGeneration` in
  `apps/console/lib/analytics/server.ts` is a no-op).

## 4. Who can apply a change

### 4.1 Alethia's own assistant

The assistant cannot apply a change on its own. `propose_operation` has no `execute`: the model's
turn stops at the proposal, and the user's approval in the dashboard calls `planProject` or
`provisionProject` (`apps/console/lib/ai/tools/operations.ts`). No model call site calls
`provisionProject`, `planProject` or `destroyProject`. I searched `lib/agent` and `lib/ai`. The scan and audit tools queue runner jobs that provision nothing.

This is what the "not high-risk" reading rests on (§6).

### 4.2 Outside agents

An outside agent is a model-driven tool the customer runs, such as a coding agent with Alethia's MCP
server or CLI configured. The customer is its deployer. Its provider is whoever built it. Alethia is
neither. What Alethia controls is what its interfaces let such an agent do:

| Path | What an outside agent can do today | Source |
| --- | --- | --- |
| Remote MCP server (`app/api/mcp/route.ts`) | Read only. The route registers the in-app read tools; no tool on it writes or queues a job | `apps/console/lib/ai/TOOLS.md`, "What the MCP route serves today" |
| The external tool contract (`apps/console/lib/ai/mcp/surface.ts`) | Declares write tools, including `request_apply` and `request_destroy`. These are data only: nothing implements them yet. As designed, `apply` and `destroy` scopes "unlock only the REQUEST for an approval", and "no tool approves" | `surface.ts` header; `TOOLS.md` |
| CLI login or service token (`app/api/jobs/route.ts`) | Acts within the deploy and destroy permissions of the account or token it uses | `app/api/jobs/route.ts` |

Second-person approval for applies made by connected agents is part of the beta programme. Until it
ships, an agent acts within the deploy and destroy permissions of the account or token it uses. This
is the customer's agent using the customer's credential, not Alethia's AI system acting. The public
page says the same (§7).

**What is planned, and when to re-check this position.** The beta decisions on agent apply say three
things. `alethia apply` under a CLI login needs a browser approval. A service token may approve a
deploy on its own only to named non-production environments, and never production or destroy. An
approval is valid for 60 minutes. Re-check this section and the page when agent-apply approval ships.

## 5. Article 50 transparency

My reading: from 2 August 2026, art. 50(1) requires a provider to design a system that interacts with
people so that they are told they are dealing with an AI system, unless that is obvious. Art. 50(2)
requires a provider of a system that generates synthetic text to mark its output in a machine-readable
form. There is an exception for systems that only assist with standard editing or do not
substantially alter the input. **Open: maintainer to confirm** the application dates against the
Official Journal text and any amendment in force.

| Duty | Status in the code |
| --- | --- |
| Art. 50(1): tell the user it is an AI system | The text exists: `AI_SYSTEM_DISCLOSURE.identification` in `apps/console/lib/ai/transparency.ts`. **No component renders it.** A search of `apps/console/app`, `components` and `lib` finds it only where it is defined. Its header says the console and the public page render it; neither does. The public page restates it in its own words |
| Art. 50(1): who provides it, its limits, how to reach a person | Same: in `AI_SYSTEM_DISCLOSURE`, rendered nowhere in the console. On the public page in prose |
| Art. 50(2): mark generated output | No machine-readable marking was found. **Open: maintainer to confirm** whether the duty applies to an assistant whose output is configuration a user reviews, or whether the exception covers it |
| A per-deployment record of each provider's evidence | `transparencyRecord()` exists and nothing calls it. The public page said "the live record for this deployment … is shown in the console under AI settings". No such screen exists, so §7 removes the sentence |

**Recommended fix (outside this unit's scope).** Render `AI_SYSTEM_DISCLOSURE` where the assistant
opens in the console, and the `transparencyRecord()` output in the AI settings. Then the page can point
to it again.

## 6. High-risk classification

`AI_SYSTEM_CLASSIFICATION.highRisk` is `false`, on the basis that the assistant "drafts infrastructure
configuration that a human reviews and approves, and decides nothing about a person's access to
services, employment, credit, education or justice."

Checked against Annex III, as I read it:

- **Points 1 and 3 to 8** (biometrics, education, employment, essential services, law enforcement,
  migration, justice): the assistant makes no decision about a person. Agreed.
- **Point 2** (critical infrastructure): it lists AI systems used as **safety components** in the
  management and operation of critical digital infrastructure. A customer may run such
  infrastructure, for example a cloud or DNS service. The assistant proposes configuration that a
  person approves, and no safety function depends on it. On that basis it is not a safety component.
  **Open: maintainer to confirm** this reading. It is the one Annex III point the product's domain
  comes close to.
- **Art. 5** (prohibited practices): none of them applies. Nothing in the product scores, manipulates
  or profiles people.

**Re-check this classification if any of these happens:**

1. Alethia's assistant can apply, destroy or approve without a person (`AI_SYSTEM_CLASSIFICATION.reassessIf`).
2. The external write tools in `surface.ts` are implemented, or `request_apply` gains a path that
   does not end at a person.
3. Agent-apply approval ships, including the planned rule that lets a service token approve on its
   own for named non-production environments. It changes this document's description of who
   approves changes.
4. The product is marketed for operating critical infrastructure as a safety function.
5. The assistant is used to decide something about a person.

## 7. The public page and this document

The page is updated in the same change as this document. Each of its statements:

| Page statement | Basis | Change in this unit |
| --- | --- | --- |
| "You are talking to a machine" | `AI_SYSTEM_DISCLOSURE.identification` | Kept. "Labelled as such in the product" removed: no label was found (§5) |
| What it can get wrong | `AI_SYSTEM_DISCLOSURE.limitations` | Kept |
| "Alethia holds no long-lived cloud keys at all" | False for token clouds (claims `security.token-clouds-encrypted`, `data-act.tokens-encrypted`; finding `privacy.static-cloud-keys` on the Privacy Policy) | Replaced: the assistant never receives cloud credentials |
| "It proposes; it does not apply" | §4.1 | Kept, and limited to Alethia's own assistant |
| Outside agents | §4.2 | **Added**: they act within the permissions of the credential the customer gives them; second-person approval for their applies is part of the beta programme |
| What is sent: prompt, infrastructure, code | §3.1 | Kept |
| Repository files sent on import | §3.2 | **Added**, with the list of files |
| The four records, and "until all four are recorded, the assistant is switched off" | `isAiConfigured()` | Kept for conversations; the page now says the repository import does not yet check them (§3.2) |
| "The live record for this deployment … is shown in the console under AI settings" | No such screen (§5) | Removed |
| Not used to train any model | Alethia: nothing in the repository trains. The provider: `ALETHIA_AI_<PROVIDER>_NO_TRAINING`, in the vault | Reworded so that the provider's commitment is one of the four records |
| Not sent to product analytics | `captureAiGeneration` is a no-op | Kept |
| Who provides the model | `processing.ts` registers Anthropic as active | **Added**: the default provider is named, with a link to the subprocessor list |

## 8. Other duties

- **AI literacy (art. 4).** It applies to providers and deployers from 2 February 2025. **Open:
  maintainer to confirm** what Alethia does to meet it for the people who build and run the
  assistant. Nothing in the repository records it.
- **Data protection.** `DPIA.md` assesses the personal-data side of the assistant and the
  repository scan.

## Open: maintainer to confirm

1. Alethia's role under art. 3: provider of the AI system, as read here, or deployer, as the code
   says. Then correct `AI_SYSTEM_CLASSIFICATION.role` and `GDPR_ACCOUNTABILITY.md`.
2. The art. 50 application dates, and whether art. 50(2) marking applies to the assistant's output.
3. The Annex III point 2 reading (not a safety component).
4. A code fix so that the repository scan checks `isAiConfigured()` before it sends files (§3.2).
5. A code fix so that the console renders `AI_SYSTEM_DISCLOSURE` and `transparencyRecord()` (§5).
6. That the four `ALETHIA_AI_ANTHROPIC_*` values are recorded in the production vault. The
   subprocessor claim `subprocessors.anthropic-default-provider` is outside-repo for that reason.
7. What is done for AI literacy under art. 4.
8. Re-check §4.2 and the page when agent-apply approval ships.
