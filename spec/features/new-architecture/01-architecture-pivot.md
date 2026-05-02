# Feature: Architecture Pivot & Tendril Deprecation

## Background & Motivation
The initial architecture envisioned an active polling agent (`Tendril`) running within the user's EKS cluster to execute infrastructure provisioning (Harvests) from within the boundary. However, to simplify the platform, reduce custom moving parts, and leverage industry standards, the architecture is pivoting to a pure **GitOps model using ArgoCD**.

The new paradigm:
1. `grape bootstrap` provisions the base EKS cluster and installs ArgoCD.
2. Trellis (Control Plane) acts as the configuration builder. When a Vine (config) is created or updated, Trellis commits the necessary Helm/K8s manifests to a designated GitOps repository.
3. ArgoCD (running on the user's cluster) automatically watches the GitOps repo and syncs the Vine configurations onto the cluster.

As a result, the `Tendril` agent is obsolete and will be removed.

## Scope & Impact
- Deletion of the `apps/tendril` directory and associated Helm charts in `apps/grape/internal/assets/helm/tendril`.
- Removal of polling endpoints and RPC functions (`fetch_next_harvest`, `update_harvest_status`) from the Trellis/Supabase backend that were specific to the Tendril agent.
- Updating `spec/architecture_design.md` to reflect the ArgoCD Pull-Based GitOps architecture instead of the Tendril remote execution model.

## Implementation Steps
1. **Clean up Agent Codebase:**
   - Run `rm -rf apps/tendril`.
   - Run `rm -rf apps/grape/internal/assets/helm/tendril`.
   - Update `apps/grape/internal/assets/embed.go` to remove references to the tendril chart.
2. **Clean up Backend Endpoints:**
   - Remove or deprecate database migrations relating to Tendril agent tokens and polling (e.g., `agent_token` columns).
3. **Update Documentation:**
   - Rewrite `spec/architecture_design.md` sections detailing the execution plane to specify ArgoCD as the synchronization engine.
