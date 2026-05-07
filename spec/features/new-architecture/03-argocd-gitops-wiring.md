# Feature: ArgoCD Bootstrapping & GitOps Wiring

## Background & Motivation
In the new architecture, Trellis needs a way to communicate configurations to the newly bootstrapped EKS cluster. Because direct communication to an internal cluster is insecure and complex, we use ArgoCD. When Trellis builds a Vine configuration, it must commit that configuration into a Git repository. ArgoCD, installed on the cluster during `bootstrap`, will sync this repository automatically.

## Scope & Impact
- Updates to Trellis Server Actions (`apps/trellis/app/server/actions/configurations.ts`) or the introduction of a new Git committing microservice/lambda.
- Ensuring the base EKS cluster is fully configured to read from the target GitOps repository.

## Implementation Steps
1. **App of Apps Configuration:**
   - The `grape bootstrap` command must configure ArgoCD with an initial "App of Apps" Application. This Application points to a folder in the Vineyard's GitOps repository (e.g., `vineyard-repo/vines/`).
2. **Trellis Config-to-Git Committer:**
   - When a user creates or updates a Vine in the Trellis UI, a new backend service or server action must serialize the configuration (e.g., `values.yaml` and ArgoCD Application manifests) and push a commit to the Vineyard's GitOps repository.
   - This eliminates the need for the `grape provision` (harvest) command to be run manually by the user on their CLI; instead, the UI action of creating the Vine inherently updates Git, and ArgoCD provisions it automatically.
3. **Status Syncing (Future/Optional):**
   - ArgoCD sync status notifications can be configured via ArgoCD Webhooks to ping the Trellis API, updating the status of the Vine in the UI without needing an active agent on the cluster.
