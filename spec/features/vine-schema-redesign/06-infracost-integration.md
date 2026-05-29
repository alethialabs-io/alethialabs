# 06 — Infracost Integration

## Two layers of cost estimation

### Layer 1: Config form (instant estimates)

When the user changes a value in the form (e.g. adds a database, changes ACU capacity, enables Redis), the cost sidebar updates immediately.

**Implementation:** Server action that calls the Infracost Cloud Pricing API.

```typescript
// apps/trellis/app/server/actions/pricing.ts
"use server";

export async function estimateComponentCost(component: string, params: Record<string, any>) {
  // Call https://pricing.api.infracost.io/graphql
  // with the appropriate resource type + region + config
  // Return monthly cost estimate
}
```

Example queries:
- EKS control plane: fixed $73/mo (or $438/mo for extended support)
- EKS nodes: look up `m5a.4xlarge` price in `eu-west-1` × node count × 730 hrs
- RDS Aurora: $0.12/ACU/hr × min_capacity × 730
- NAT Gateway: fixed $32.85/mo per gateway
- ElastiCache: look up `cache.t3.medium` price × node count × 730

The pricing API is free and doesn't need Terraform — it's just a resource price lookup.

Each component table has `estimated_monthly_cost`. Updated whenever the user saves changes to a component.

The vine's total cost = SUM of all component costs.

### Layer 2: Worker (accurate breakdown after terraform plan)

After `terraform plan`, the worker runs `infracost breakdown --path tfplan.json` using the user's Infracost API key (stored as an env var on the Fargate task).

This gives per-resource costs including data transfer, storage, requests — things the form can't estimate.

The worker writes the Infracost breakdown back to the vine via the API:
```
PUT /api/vines/{id}/cost
{ "monthly_cost": 342.17, "breakdown": [...] }
```

This replaces the form estimates with real numbers after the first provision.

## Infracost API key management

- **Form estimates:** Use a platform-level Infracost API key stored in Trellis env vars. The pricing API is free tier.
- **Worker breakdown:** Infracost CLI key stored in the Fargate task's Secrets Manager or env var.

## Cost display in the UI

The config form sidebar shows:

```
Estimated Monthly Cost: $285.03

  EKS Control Plane      $73.00
  EKS Nodes (3× t3.md)   $91.98
  NAT Gateway             $32.85
  Aurora PG (0.5-4 ACU)   $43.80
  ElastiCache Redis       $24.84
  WAF                      $5.00
  SQS                      $0.00
  SNS                      $0.00
  DynamoDB                 $0.00
  ─────────────────────────────
  ECR                      $0.00
  ACM                      $0.00
  Secrets Manager         $13.56
```

After provisioning, the sidebar updates with actual Infracost numbers and a "Last updated" timestamp.
