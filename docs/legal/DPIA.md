<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Data protection impact assessment

**Status: Draft — pending maintainer legal review (#7351).** Written by an agent for LEG-L4 (#6922).
No lawyer has reviewed it, and no data protection officer has been consulted: none is named
(`RECORDS_OF_PROCESSING.md`, "The controller").

Owner: LEG-L4 (#6922)

Effective: 2026-11-23

`GDPR_ACCOUNTABILITY.md` lists the DPIA as not established: "Whether a DPIA has been carried out for
the AI feature and for infrastructure-control processing, and where the assessment is retained."
This document is that assessment, in draft. It follows art. 35(7): it describes the processing,
assesses necessity and proportionality, assesses the risks to people, and lists the measures. Each
fact names its source in the code or in `legal-set.json`.

Risk levels are an agent's judgement on the facts stated, not a finding of a supervisory authority.
The maintainer decides whether they stand.

## 1. Is a DPIA required?

Art. 35(1) asks for one where processing is likely to result in a high risk, "in particular using new
technologies". The EDPB-endorsed criteria (WP248 rev.01) suggest that two or more of nine criteria
usually mean a DPIA is needed. Against the three activities assessed here:

| Criterion | AI assistance and repository scans (§2) | Infrastructure control (§3) | Authorization log (§4) |
| --- | --- | --- | --- |
| Innovative use of new technology | Yes: a large language model | No | No |
| Sensitive or highly personal data | Possible: whatever a user pastes; secrets in repository files | Incidental | No |
| Systematic monitoring | No | No | Yes: every allow and deny for every member, for 365 days |
| Large scale | Not at beta | Not at beta | Not at beta |
| Data transferred outside the EEA | Yes: Anthropic, region "United States" (`processing.ts`) | No (Hetzner `fsn1`) | No |
| Matching or combining datasets | No | No | No |
| Vulnerable data subjects | No | No | Employees of customers, in a power imbalance with their employer, who reads the log |
| Automated decision with legal or similar effect | No (§2.4) | No | No |
| Prevents a person from exercising a right or using a service | No | No | No |

On this reading, the AI activity meets two criteria (new technology; possibly sensitive data, with
a transfer). The authorization log meets two (systematic monitoring; employees). Infrastructure
control meets none clearly. **The assessment is done for all three**, because the cost of doing it is
lower than the cost of being wrong about whether it was needed. **Open: maintainer to confirm** this
screening.

## 2. AI assistance and repository scans

### 2.1 Description

| Element | Fact | Source |
| --- | --- | --- |
| What is processed | The user's prompt and pasted content; a derived project-knowledge block (identity, environments, last five jobs, ≤ 2000 characters); results of read tools run as the user; on repository import, the text of manifests, Dockerfiles, compose and Kubernetes files, CI files and `.env.example`-style templates (each ≤ 64 KiB, ≤ 120,000 characters sent) | `AI_ACT_POSITION.md` §3 |
| Who | Users of the console; anyone named in the content they paste or in their repository | — |
| Where it goes | Anthropic, the default provider. OpenAI only under an operator's `openai/*` override | `apps/console/lib/config/ai.ts`; `processing.ts` |
| What is stored | Conversations (`agent_threads`); unsent drafts (`elench_drafts`); scan digests (`jobs.execution_metadata`); usage records (`ai_usage_ledger`) | `RETENTION_SCHEDULE.md` |
| Lawful basis | Contract; customer instructions under the DPA | `GDPR_ACCOUNTABILITY.md` |
| Role | Processor for the customer (`RECORDS_OF_PROCESSING.md` B2) | — |

### 2.2 Necessity and proportionality

- The feature is optional. A user who never opens the assistant or imports a repository sends nothing
  to the model provider. The public page says this.
- What a scan reads is limited to the file kinds that describe infrastructure needs, not application
  source code (`packages/core/scanner/scanner.go`).
- The project-knowledge block is capped at 2000 characters.
- Tools act with the user's own permissions; there is no second authority model
  (`apps/console/lib/ai/TOOLS.md`).
- Prompts and outputs are not sent to product analytics (`captureAiGeneration` is a no-op).

Two things are not proportionate today, and §2.5 lists them: there is no retention period for
conversations or scan digests, and the scan does not ask the evidence gate.

### 2.3 Risks

| # | Risk to people | Likelihood | Severity | Notes |
| --- | --- | --- | --- | --- |
| R1 | A secret or personal data in a repository file or a pasted prompt reaches the provider and is kept there | Possible | Significant | The provider's retention is a vault value (`ALETHIA_AI_ANTHROPIC_RETENTION`), not in the repository |
| R2 | Repository content is sent before the DPA, transfer mechanism, retention and no-training commitment are recorded | Possible: the scan path does not check them (`AI_ACT_POSITION.md` §3.2) | Significant | The chat routes do check them |
| R3 | Transfer to the United States without a recorded mechanism | Depends on the vault value `ALETHIA_AI_ANTHROPIC_TRANSFER` | Significant | `processing.ts` gives the region as "United States" |
| R4 | Conversations and scan digests are kept as long as the account exists, and some after erasure | Certain today | Limited to significant | `RETENTION_SCHEDULE.md` §4. Erasure erases `agent_threads`. It does not list `jobs` or `ai_usage_ledger` |
| R5 | Content in a repository steers the model (prompt injection), so the proposal it produces is wrong | Possible | Limited | The system prompt fences the digest as untrusted data (`apps/console/lib/scanner/infer.ts`). The output is a proposal a person reviews. It applies nothing (`AI_ACT_POSITION.md` §4.1) |
| R6 | The model is confidently wrong about infrastructure, and the user approves a harmful change | Possible | Significant for availability; indirect for personal data | Disclosed as a limitation. The verification gate runs on every plan either way (`AI_SYSTEM_DISCLOSURE.autonomy`) |
| R7 | The user is not told in the console that they are dealing with an AI system | Likely: the disclosure is not rendered (`AI_ACT_POSITION.md` §5) | Limited | A transparency failure more than a data one |

### 2.4 Automated decisions (art. 22)

None. The assistant decides nothing about a person. It proposes configuration and a person approves
it (`AI_ACT_POSITION.md` §4.1).

### 2.5 Measures

| Measure | Status | Addresses |
| --- | --- | --- |
| Fail-closed evidence gate on the chat routes (`isAiConfigured()`) | In place | R1–R3 for chat |
| The same gate on the repository scan (`queueRepoScan`, `inferStack`) | **Missing**; recommended in `AI_ACT_POSITION.md` §3.2 | R2, R3 for scans |
| The four `ALETHIA_AI_ANTHROPIC_*` values recorded in the vault | **Open: maintainer to confirm** | R1, R3 |
| A retention period for `agent_threads` and for scan digests in `jobs`, enforced by a sweep and in the register | **Missing**; `RETENTION_SCHEDULE.md` §4 | R4 |
| Erasure covering scan digests and AI usage records, or a recorded reason they are kept | **Missing** | R4 |
| Digest fenced as untrusted in the system prompt | In place | R5 |
| No model path can apply a change | In place (`AI_ACT_POSITION.md` §4.1) | R5, R6 |
| Disclosure rendered in the console | **Missing**; `AI_ACT_POSITION.md` §5 | R7 |
| Public disclosure at `/ai-transparency`, including what a repository import sends | Updated with this document | R1, R7 |

**Residual risk:** with the missing measures in place, I judge the residual risk not high, so no prior
consultation under art. 36 is needed. **Without them, R2 and R4 stay open.** **Open: maintainer to
confirm** the residual-risk judgement, and whether the scan gate must land before the beta.

## 3. Infrastructure control

### 3.1 Description

Alethia stores a customer's project configuration and runs plan, apply and destroy in the customer's
cloud. It holds the OpenTofu state, and it reads and writes the customer's GitOps repository.
Personal data is incidental: names and emails in commit metadata and configuration, and whatever the
customer's tooling prints to a job log (`RECORDS_OF_PROCESSING.md` B1).

### 3.2 Necessity and proportionality

The processing is the service the customer asked for. Federated clouds store no key (claim
`data-act.federated-clouds-store-no-key`). Token clouds and connector keys are encrypted at rest
(claims `data-act.tokens-encrypted`, `security.token-clouds-encrypted`). Job logs go after 30 days and
the fleet action ledger after 90 (`RETENTION_SCHEDULE.md` §1).

### 3.3 Risks and measures

| # | Risk | Measure | Status |
| --- | --- | --- | --- |
| R8 | A credential or personal data printed by the customer's tooling stays in a job log | Logs deleted after 30 days (`gc_job_logs`) | In place |
| R9 | A stored cloud token is exposed | Encrypted at rest; never held when the customer runs a self-managed runner (claim `security.token-clouds-encrypted`) | In place |
| R10 | A change applied by a connected agent is wrong for the customer's infrastructure | The agent acts within the deploy and destroy permissions of the account or token it uses; second-person approval for applies made by connected agents is part of the beta programme (`AI_ACT_POSITION.md` §4.2) | Planned for the beta |
| R11 | Job rows (configuration snapshots, metadata) are kept with no period | — | **Missing**; `RETENTION_SCHEDULE.md` §4 |

R10 is mostly a risk to the customer's infrastructure and availability, not to personal data. It is
listed because the public page describes approvals.

**Residual risk:** not high. **Open: maintainer to confirm.**

## 4. Authorization activity log

### 4.1 Description

Every allow and deny the policy engine makes is recorded in `authz_activity_log`, with the actor, for
365 days by default. The table is append-only. A WORM trigger refuses every UPDATE, so the actor
cannot be pseudonymized in place. The row expires through `gc_authz_activity_log`
(`apps/console/lib/retention/registry.ts`, `authz-activity`;
`apps/console/lib/privacy/erasure-plan.ts`).

### 4.2 Necessity and proportionality

The register states the purpose: the log "is the record that answers 'who could have seen this?'".
That question can be asked after a breach that affects other people. Erasure keeps the row on the
grounds of art. 17(3)(b) and (e) (`erasure-plan.ts`).

What is not shown in the repository is a limit on **who in the customer organization can read the
log, and for what**. An employer could use a year of every allow and deny to monitor an individual
employee.

### 4.3 Risks and measures

| # | Risk | Measure | Status |
| --- | --- | --- | --- |
| R12 | An employer uses the log to monitor an individual member | Who can read the log, and the purpose, stated in the DPA or the customer documentation | **Open: maintainer to confirm**. Not examined in the code for this draft |
| R13 | The log outlives the need | 365-day expiry, overridable by `ALETHIA_AUTHZ_ACTIVITY_RETENTION_DAYS` | In place |

**Residual risk:** not high, provided R12 is answered. **Open: maintainer to confirm.**

## 5. Review

Review this assessment when any of these happens:

- the assistant gains a new data source;
- an outside write tool is implemented;
- agent-apply approval ships;
- a new model provider is configured;
- a retention period in §2.5 or §3.3 is set;
- the beta opens to a scale that changes the "large scale" answer in §1.

## Open: maintainer to confirm

1. The screening in §1, and that a DPIA is carried out for all three activities.
2. That the four `ALETHIA_AI_ANTHROPIC_*` values (DPA, transfer, retention, no-training) are recorded
   in the production vault.
3. Whether the repository-scan evidence gate (R2) must land before the beta.
4. A retention period for assistant conversations, scan digests and job rows (R4, R11).
5. Who in a customer organization may read the authorization log, and for what (R12).
6. The residual-risk judgements in §2.5, §3.3 and §4.3, and so that no prior consultation is needed.
7. Where the signed-off assessment is retained. `GDPR_ACCOUNTABILITY.md` asks this too.
