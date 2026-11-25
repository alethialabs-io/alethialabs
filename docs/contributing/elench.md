<!-- Moved out of the user docs (apps/docs, /concepts/elench/engine-internals, /extending, /architecture, /multi-cloud) by the concepts rework: contributor material. -->

# Elench internals

How the verification engine and the agent harness described in
[Elench](https://alethialabs.io/docs/concepts/elench) are built.

## The Evaluate seam

`packages/core/verify` exposes `Evaluate(ctx, plan *tfjson.Plan) (*Report, error)`: deterministic and
side-effect free. `EvaluateWithOptions` adds AWS Access Analyzer corroboration through the
`PolicyChecker` seam (implemented in `packages/core/accessanalyzer`, control `ACCESS-ANALYZER-001`,
enabled by `ALETHIA_VERIFY_ACCESS_ANALYZER=1`). Other entry points: `ParseCustomerPlan(json)` →
`Evaluate` for a bring-your-own plan, and `EvaluateManifests(yaml)` for the Kubernetes control set.
The `AUDIT` job (`executeAudit`) uses the latter two.

The gate runs inside `provisioner.RunDeployV2`; on a non-dry-run apply `Report.Unwaived(override)`
must be empty before `tofu apply`. Overrides are stored on `jobs.verify_override`, stamped by
`recordVerifyOverride`, and rebuilt on the runner by `buildVerifyOverride`.

## Adding a control

1. Add a `control…` function in `packages/core/verify` returning a `ControlResult`. Use
   `resolveStatus` and the policy helpers (`parseIAMPolicy`, `attrUnknown`, `toStringSlice`).
2. Add a plan-JSON fixture under `testdata/` and a test, always including a `not_evaluable` case for a
   control that reads a body that can be computed.
3. Bump `CatalogVersion` (`types.go`) when a verdict could change.

A Kubernetes control goes in `packages/core/verify/k8s.go`, wired into `EvaluateManifests`, with an
insecure and a clean fixture.

## AI stays advisory

| Seam | Role |
| --- | --- |
| `PolicyChecker` | Access Analyzer corroboration |
| `Remediator` | Proposes a fix and re-plans |
| `SubAgentRunner` | Runs one delegated colony task |
| injected model call | The LLM in `explainFindings` and the agent runner |

`ReVerify(original, candidatePlan)` reports resolved, still-failing and newly failing controls; a fix
is accepted only when every original failure is resolved with no regression.
`RunRemediationLoop` bounds the loop.

## The `elench-verify` CLI

```bash
go build -o elench-verify ./packages/core/verify/cmd/elench-verify
tofu show -json tfplan | elench-verify   # exit 2 if the verdict blocks
elench-verify -json plan.json
elench-verify -manifests deploy.yaml
```

Exit codes: `0` pass/warn/not_evaluable, `2` fail, `1` usage or parse error.

## Gated live tests

```bash
ELENCH_LIVE=1 ANTHROPIC_API_KEY=… pnpm -F console exec vitest run tests/lib/agent/llm-live.test.ts
ELENCH_LIVE_AWS=1 AWS_REGION=us-east-1 go test ./packages/core/accessanalyzer -run TestLive -v
ELENCH_PLAN_BAD=bad.json ELENCH_PLAN_FIXED=fixed.json go test ./packages/core/verify -run TestLiveReVerifyRealPlans -v
```

## Agent harness

- Tools: `apps/console/lib/ai/tools/`, audiences in `registry.ts`; `buildExternalAgentTools()` is the
  read-only projection; `assertAudienceCoverage` fails CI for a tool without an audience.
- MCP: `app/api/mcp/route.ts`; operation tools declared in `lib/ai/mcp/surface.ts`, handled in
  `lib/ai/mcp/handlers.ts`.
- Agents: `agent_identities`; memory in `agent_memory` keyed by `(namespace, path)`, paths validated
  by `lib/agent/memory-path.ts`; pinned context in `agent_context`.
- `lib/agent/executor.ts`: `buildAgentSystemPrompt`, `scopeToolsToAgent`.
- `lib/agent/supervisor.ts`: a deterministic Task/Progress-ledger supervisor with a stall counter
  (`stall > 2 → re-plan`); use it for read fan-out, not write/converge work.

## Adding a cloud to the GitOps seam

1. `<cloud>_provider.go` implementing `CloudProvider`, plus a case in `NewCloudProvider`.
2. The OpenTofu template, with a keyless workload-identity binding for the external-dns service
   account, exported as an output.
3. Runner credential activation.
4. A `BuildFromOutputs` case and per-cloud block in `packages/core/argocd/infra_facts.go`, and the
   branch in `infra/templates/argocd/external-dns.yaml`. An empty render means "not applicable".

See also `packages/core/cloud/README.md` and `packages/core/verify/README.md`.
