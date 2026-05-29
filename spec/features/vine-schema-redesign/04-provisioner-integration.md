# 04 — Provisioner Integration

## How the worker uses the new schema

### Job creation (Trellis side)

When a user clicks "Provision" on a vine, Trellis:

1. Reads the vine + all component tables (or uses `vine_full` view)
2. Creates a `provision_jobs` entry with `config_snapshot` containing the flat view data
3. The worker claims the job and parses `config_snapshot` into the existing `Configuration` Go struct

This means **no Go code changes are needed initially**. The `config_snapshot` is a frozen copy of `vine_full` at queue time — same shape as the old `configurations` table.

### Component status updates (worker side)

As the worker provisions, it should update individual component statuses. This requires a new API route that the worker calls at each stage.

#### New API route: `PUT /api/vines/{vine_id}/components`

```json
POST body:
{
  "component": "vpc",        // vpc | eks | database | redis | dns
  "status": "CREATING",      // PENDING | CREATING | ACTIVE | FAILED
  "status_message": "Creating VPC with CIDR 10.0.0.0/16..."
}
```

The worker calls this at key points during provisioning:

```
                          Time →
VPC:      CREATING ──────────── ACTIVE
EKS:                CREATING ──────────────────── ACTIVE
RDS:                CREATING ────────── ACTIVE
Redis:              (disabled, stays PENDING)
DNS:                                    CREATING ── ACTIVE
```

#### Where to insert the status updates in deploy.go

The `RunDeploy` function has clear stages. Add status update calls at each:

```
1. S3 state bucket         → no component (infrastructure setup)
2. Clone template repos    → no component (preparation)
3. Terraform init          → no component
4. Terraform plan          → vpc=CREATING, eks=CREATING, database=CREATING (all at once — Terraform does them)
5. Terraform apply         → (during execution, Terraform creates resources)
6. Terraform outputs       → vpc=ACTIVE (VPC created), database=ACTIVE (RDS created)
7. kubectl config          → eks=ACTIVE (EKS accessible)
8. ArgoCD install          → no component (add-on)
9. ArgoCD manifests        → dns=ACTIVE (if enabled)
```

In practice, since Terraform creates everything in one `apply`, we can:
- Set all enabled components to `CREATING` before `terraform apply`
- Set all to `ACTIVE` after successful `apply`
- Set individual ones to `FAILED` with the error if `apply` fails

More granular updates (per-resource within Terraform) would require parsing Terraform's streaming output, which is possible but complex. Good for a later iteration.

#### Worker API client addition

```go
// In apps/grape/worker/api.go
func (c *WorkerAPIClient) UpdateComponentStatus(vineID, component, status, message string) error {
    body := map[string]string{
        "component":      component,
        "status":         status,
        "status_message": message,
    }
    // PUT /api/vines/{vine_id}/components
}
```

#### How the vine's overall status derives from components

The vine `status` should be updated automatically:
- If any component is `CREATING` → vine is `PROVISIONING`
- If all enabled components are `ACTIVE` → vine is `ACTIVE`
- If any component is `FAILED` → vine is `FAILED`
- This can be a database trigger or calculated in the API

### What the frontend shows

With per-component status, the vine detail page can show:

```
┌─────────────────────────────────────────┐
│ Vine: my-project (dev)                  │
│ Status: Provisioning                     │
├─────────────────────────────────────────┤
│ ✓ VPC           ACTIVE    10.0.0.0/16   │
│ ⟳ EKS           CREATING  (8m elapsed) │
│ ⟳ Database      CREATING  Aurora PG     │
│ ○ Redis          Disabled               │
│ ○ DNS            Pending                │
└─────────────────────────────────────────┘
```

Each component row is clickable → shows its specific config + status_message.
