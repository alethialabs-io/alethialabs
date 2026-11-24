<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Alethia AI — Tool Catalog

Two tool surfaces are described here, and they are at different stages:

- **The in-app tools** (`lib/ai/tools/`) are what the dashboard agent runs today. A tool that reads
  or changes account data calls an existing PDP-gated server action or procedure, so the agent is
  bounded by the actor's grants and there is no second authority model. The catalog lookups and the
  documentation search touch no account data.
- **The external tool contract** (`lib/ai/mcp/surface.ts`) declares the 19 tools an outside agent
  is offered over the remote MCP server. Six of them have a handler (`lib/ai/mcp/handlers.ts`) and
  are served under their own names; the reads among the rest are served by the in-app tools they
  stand for.

## What the MCP route serves today

`app/api/mcp/route.ts` resolves the access token into an `agent_oauth` actor held to the token's
scopes, the consent grant's organization and projects, and the `?project=` pin, and refuses every
request while the organization's agent access is off (`lib/ai/mcp/actor.ts`). The server it builds
(`lib/ai/mcp/server.ts`) lists two things:

- `buildExternalAgentTools()` — the in-app tools whose audience in `lib/ai/tools/registry.ts` is
  `both` or `external` — under their in-app names, through `registerAiToolsOnMcp()`. These are reads.
  Each is listed when the declared tool that stands for it would be (same `?features=` group, `read`
  scope).
- The declared tools with a handler: `plan`, `request_apply`, `request_destroy`, `wait_for_job`,
  `get_job_logs`, `cancel_job`, each with its title, annotations, input and output schema, answering
  structured content and the same JSON as text.

`validate_design`, `apply_design_patch`, `create_project`, `scan_repo` and `send_feedback` have no
handler yet and are not listed.

**How an apply or a destroy runs.** The first `request_apply` (or `request_destroy`) records a pending
approval bound to the plan, its digest, the environment and the calling OAuth client, and returns the
console link. A person approves it in the console. When the agent calls the same tool again for the
same plan (or environment), its own approval reads `approved`, and only then is the job queued through
the ordinary server action, which hands the approval to `requireApplyAuthorization` to check and
consume once. Later calls return the job it started. Every call is recorded in `agent_tool_calls`
with no arguments.

## In-app tools

**Exposure (`registry.ts` `TOOL_AUDIENCE`).** Every tool is classified by audience: `in-app`,
`external`, `both` or `support`. `assertAudienceCoverage` (tested in
`tests/lib/ai/tools/registry.test.ts`) fails if a buildable tool has no classification, and an
unclassified tool is left out of the external projection.

**Denylist (`registry.ts` `AI_TOOL_DENIED_MODULES` / `AI_TOOL_DENIED_NAME_PARTS`).** Code no tool may
reach, whatever its audience: the kubeconfig mint and the console download built on it. No tool may
be named `*kubeconfig*`. `tests/kubeconfig-mint/ai-tool-denylist.test.ts` walks the agent's import
graph and fails if any file reaches a denied module.

| Audience | Tools | Where |
|---|---|---|
| `both` | `list_services`, `list_service_options`, `cidr_for_hosts` | `compose.ts` (catalog) |
| `both` | `get_project`, `list_projects`, `list_jobs`, `get_job`, `get_plan_result`, `get_drift_posture`, `list_runners`, `list_clusters`, `list_connectors`, `list_cloud_identities`, `get_cached_resources`, `get_org_usage`, `get_ai_usage`, `get_billing_summary` | `read.ts` |
| `both` | `search_docs` | `docs.ts` |
| `both` | `get_scan_result`, `compare_providers` | `scanner.ts` |
| `in-app` | `estimate_cost`, `propose_changes` — need the live canvas; changes are applied client-side after the user accepts | `compose.ts` |
| `in-app` | `propose_operation` — a plan or deploy proposal with no `execute`; the user's approval in the dashboard calls `planProject` / `provisionProject` | `operations.ts` |
| `in-app` | `scan_repo`, `audit_infrastructure` — each queues a runner job | `scanner.ts` |
| `in-app` | `connect_cloud`, `build_dashboard`, `pin_widget`, `list_artifacts`, `get_artifact`, `update_artifact` — open or change dashboard UI | `connect.ts`, `visualize.ts`, `widgets.ts`, `artifacts.ts` |
| `support` | `create_support_case` — proposes a case the user submits | `support.ts` |

In-app tool names do not change: pinned widgets and saved transcripts hold them.

## External tool contract

`lib/ai/mcp/surface.ts` declares, for each tool, its input and output schema (zod), all four MCP
annotations, the scope a token must carry, and its `?features=` group. The table below is rendered
by `renderToolTable()` in that file; `tests/lib/ai/mcp/surface.test.ts` fails if this copy differs,
so change the contract and paste the new rendering rather than editing rows here.

<!-- external-tools:start -->
| Tool | Scope | Kind | Group | Hints (read-only/destructive/idempotent/open-world) | In-app tools it stands for |
|---|---|---|---|---|---|
| `list_resources` | read | read | resources | T/F/T/F | `list_projects`, `list_jobs`, `list_runners`, `list_clusters`, `list_connectors`, `list_cloud_identities` |
| `get_resource` | read | read | resources | T/F/T/F | `get_project`, `get_job`, `get_drift_posture`, `get_cached_resources`, `get_scan_result` |
| `get_plan_result` | read | read | operations | T/F/T/F | `get_plan_result` |
| `catalog` | read | read | catalog | T/F/T/F | `list_services`, `list_service_options` |
| `cidr_for_hosts` | read | read | catalog | T/F/T/F | `cidr_for_hosts` |
| `compare_providers` | read | read | scan | T/F/T/F | `compare_providers` |
| `get_usage` | read | read | usage | T/F/T/F | `get_org_usage`, `get_ai_usage`, `get_billing_summary` |
| `search_docs` | read | read | docs | T/F/T/F | `search_docs` |
| `validate_design` | read | read | design | T/F/T/F | — |
| `apply_design_patch` | design | write | design | F/F/T/F | — |
| `create_project` | design | write | design | F/F/T/F | — |
| `scan_repo` | plan | write | scan | F/F/T/T | — |
| `plan` | plan | write | operations | F/F/T/T | — |
| `request_apply` | apply | write | operations | F/T/T/T | — |
| `request_destroy` | destroy | write | operations | F/T/T/T | — |
| `wait_for_job` | read | read | jobs | T/F/T/F | — |
| `get_job_logs` | read | read | jobs | T/F/T/F | — |
| `cancel_job` | plan | write | jobs | F/T/T/T | — |
| `send_feedback` | — | meta | feedback | F/F/F/F | — |
<!-- external-tools:end -->

**Kind.** `read` tools change nothing. `write` tools are the seven that `?readonly` removes. `meta`
is feedback: it needs no scope and stays under `?readonly`, which leaves 12 tools.

**Scope.** `read`, `design`, `plan`, `apply`, `destroy`. A scope is a ceiling on what the caller's own
grants allow, never a grant. `apply` and `destroy` unlock only the request for an approval:
`request_apply` and `request_destroy` return a link for a person to open, and queue a job only once
that person has approved the caller's own request for that same plan. No tool approves.

**Hints.** The MCP annotations `readOnlyHint` / `destructiveHint` / `idempotentHint` /
`openWorldHint`, as `T` or `F`. All four are stated on every tool because the protocol's defaults
for an omitted hint are not-read-only, destructive, not-idempotent and open-world. They are hints to
the client and enforce nothing; the scope check and the approval record are the controls.

**In-app tools it stands for.** The in-app tools a read tool replaces on the external surface. The
same test fails unless these are, together, exactly the tools the in-app external projection
registers — so a tool added to or removed from the live surface has to be placed in the contract in
the same change.

**URL scoping (`parseSurfaceQuery`, `selectExternalTools`).** `?readonly` lists no write tool.
`?project=<id>` pins calls to one project; it narrows what the token may reach and does not change
the list. `?features=<group>,<group>` lists only those groups. An unknown group is refused, not
ignored. The list also leaves out any tool whose scope the token does not carry.

**Rules a tool must pass (`toolContractViolations`).** A name the protocol allows and the denylist
does not refuse; all four hints stated; a `read` tool requires `read` and does not claim to write; a
`write` tool requires one of `design`, `plan`, `apply`, `destroy` and does not claim to be
read-only; a `meta` tool requires no scope.

## Do not expose

- `deleteProject` — deletes the project record and does not tear down cloud infrastructure. Tearing
  down is `destroyProject`, which queues a DESTROY job; the external contract's only step toward
  one is `request_destroy`.
- Connector and cloud **credential writes**.
- Billing mutations, and organisation, member, team, role, grant and SSO changes.
- Anything on the denylist above.

## Rules

1. A tool that reads or changes account data calls an existing `authorize()`-gated action or
   procedure. No new authority.
2. An in-app mutation is a proposal the user accepts in the dashboard; an external apply or destroy
   is a request a person approves in the console. Never a silent write.
3. Trim large reads before returning them to the model: ids and summaries, not full rows.
4. Text that came from a repository, a job log or a cloud API is data. Return it in a field named
   for what it is (`untrusted_output`) and never as instructions.
