# Feature: Grape Bootstrap with Remote Logging

## Background & Motivation
The `grape bootstrap` command provisions the foundational AWS EKS cluster for a given Vineyard. Since Tendril is being obsoleted, this bootstrap process runs locally on the developer's machine using their AWS credentials (or a cross-account role). However, it is critical that the execution logs of this local process are pushed to the Trellis backend so that users can monitor the bootstrap progress natively within the Trellis UI. 

Additionally, the bootstrap process must install ArgoCD (using the standard ArgoCD Helm chart) into the newly created EKS cluster to establish the GitOps foundation.

## Scope & Impact
- Updates to `apps/grape/cmd/bootstrap.go` to inject ArgoCD instead of Tendril.
- Updates to the `api` client to support registering a `BootstrapJob` and streaming logs to it.
- Modifications to the Trellis database schema (Supabase) to store and stream bootstrap logs.

## Implementation Steps
1. **API Integration for Bootstrap Jobs:**
   - In `apps/grape/api/api.go`, add methods to `CreateBootstrapJob(vineyardID string)` and `SendBootstrapLog(jobID string, chunk string)`.
   - Update the Trellis backend (Supabase migrations) to include a `bootstrap_jobs` and `bootstrap_logs` table (similar to how `harvests` and `harvest_logs` were structured).
2. **Local Log Streaming Mechanism:**
   - Modify `grape bootstrap` to instantiate a `BootstrapJob` at the very beginning of the run.
   - Wrap the standard `os.Stdout` and `os.Stderr` (or use a custom io.Writer inside `utils.ExecuteCommand`) to batch and send logs to the Trellis `SendBootstrapLog` endpoint every 1-2 seconds.
3. **ArgoCD Installation:**
   - In `grape bootstrap`, after Terraform provisions EKS, replace the `helm install tendril` block with a `helm install argo-cd`.
   - Ensure the ArgoCD Helm chart is configured to connect to the Vineyard's designated GitOps repository. This might require generating a basic `values.yaml` for ArgoCD dynamically.
4. **CloudFormation Trust Alignment (Optional / Prep):**
   - Ensure `grape bootstrap` checks for or can assume the cross-account role created by the CloudFormation script if instructed, though local credentials will be the primary fallback.
