# 05 — Trellis Integration

## Server actions

### Replace `configurations.ts` with `vines.ts`

The existing server actions in `app/server/actions/configurations.ts` need to be replaced with actions that write to the new tables.

#### `createVine(data)`

Creates a vine + all component rows in a single operation:

```typescript
export async function createVine(data: CreateVineInput) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // 1. Insert vine
  const { data: vine } = await supabase.from("vines").insert({
    project_name: data.projectName,
    environment_stage: data.environment,
    aws_region: data.region,
    aws_account_id: data.awsAccountId,
    vineyard_id: data.vineyardId,
    cloud_identity_id: data.cloudIdentityId,
    terraform_version: data.terraformVersion,
  }).select().single();

  // 2. Insert component configs
  await Promise.all([
    supabase.from("vine_vpc").insert({
      vine_id: vine.id,
      provision_vpc: data.vpc.createNew,
      vpc_id: data.vpc.existingVpcId,
      vpc_cidr: data.vpc.cidr,
    }),
    supabase.from("vine_eks").insert({
      vine_id: vine.id,
      cluster_version: data.eks.version,
      enable_karpenter: data.eks.karpenter,
      cluster_admins: data.eks.admins,
    }),
    supabase.from("vine_database").insert({
      vine_id: vine.id,
      enabled: data.database.enabled,
      min_capacity: data.database.minCapacity,
      max_capacity: data.database.maxCapacity,
    }),
    supabase.from("vine_redis").insert({
      vine_id: vine.id,
      enabled: data.redis.enabled,
      allowed_cidr_blocks: data.redis.cidrBlocks,
    }),
    supabase.from("vine_dns").insert({
      vine_id: vine.id,
      enabled: data.dns.enabled,
      dns_main_domain: data.dns.domain,
      dns_hosted_zone: data.dns.hostedZone,
      cloudfront_waf_enabled: data.dns.waf,
    }),
    supabase.from("vine_repositories").insert({
      vine_id: vine.id,
      env_destination_repo: data.repos.envRepo,
      gitops_destination_repo: data.repos.gitopsRepo,
      gitops_argocd_token: data.repos.argocdToken,
      apps_destination_repo: data.repos.appsRepo,
      apps_token: data.repos.appsToken,
    }),
  ]);

  return { vine };
}
```

#### `provisionVine(vineId)`

Reads from `vine_full` view, creates provision job with flat config_snapshot:

```typescript
export async function provisionVine(vineId: string) {
  const supabase = await createClient();

  // Read the flat view
  const { data: vineFull } = await supabase
    .from("vine_full")
    .select("*")
    .eq("id", vineId)
    .single();

  // Get cloud identity
  const { data: identity } = await supabase
    .from("cloud_identities")
    .select("id")
    .eq("provider", "aws")
    .eq("is_verified", true)
    .maybeSingle();

  // Queue job
  const { data: job } = await supabase.from("provision_jobs").insert({
    vineyard_id: vineFull.vineyard_id,
    cloud_identity_id: identity.id,
    job_type: "DEPLOY",
    configuration_id: vineId,
    config_snapshot: { ...vineFull },
    status: "QUEUED",
  }).select("id").single();

  // Update vine status
  await supabase.from("vines").update({ status: "QUEUED" }).eq("id", vineId);

  return { jobId: job.id };
}
```

#### `getVine(vineId)` — with component details

```typescript
export async function getVine(vineId: string) {
  const supabase = await createClient();

  const [vine, vpc, eks, db, redis, dns, repos] = await Promise.all([
    supabase.from("vines").select("*").eq("id", vineId).single(),
    supabase.from("vine_vpc").select("*").eq("vine_id", vineId).maybeSingle(),
    supabase.from("vine_eks").select("*").eq("vine_id", vineId).maybeSingle(),
    supabase.from("vine_database").select("*").eq("vine_id", vineId).maybeSingle(),
    supabase.from("vine_redis").select("*").eq("vine_id", vineId).maybeSingle(),
    supabase.from("vine_dns").select("*").eq("vine_id", vineId).maybeSingle(),
    supabase.from("vine_repositories").select("*").eq("vine_id", vineId).maybeSingle(),
  ]);

  return {
    vine: vine.data,
    components: {
      vpc: vpc.data,
      eks: eks.data,
      database: db.data,
      redis: redis.data,
      dns: dns.data,
      repositories: repos.data,
    },
  };
}
```

## Configuration form changes

The form (being reworked in another Claude instance) should write to the new tables. Each form section maps to a component table:

| Form section | Table |
|-------------|-------|
| Project Basics | `vines` |
| AWS & Network | `vines` (region, account) + `vine_vpc` |
| Platform & EKS | `vine_eks` |
| Repositories | `vine_repositories` |
| Database | `vine_database` |
| Advanced (DNS, Redis, WAF) | `vine_dns` + `vine_redis` |

## Vine detail page — per-component status

The vine detail sheet (or a dedicated page) should show each component's status:

```
┌─────────────────────────────────────────────────────┐
│ my-project (development) — eu-west-1                │
│ Overall: Provisioning                                │
├─────────────────────────────────────────────────────┤
│                                                      │
│  VPC         ✓ Active    10.0.0.0/16                │
│  EKS         ⟳ Creating  v1.32, Karpenter enabled   │
│  Database    ⟳ Creating  Aurora PG, 0.5-4 ACU       │
│  Redis       ○ Disabled                              │
│  DNS         ○ Pending   example.com                 │
│                                                      │
│  [View Logs]  [Destroy]                              │
└─────────────────────────────────────────────────────┘
```

## API route for component status updates

**New route:** `apps/trellis/app/api/vines/[id]/components/route.ts`

Worker calls this to update component statuses during provisioning:

```typescript
// PUT /api/vines/{vine_id}/components
// Body: { component: "vpc", status: "ACTIVE", status_message: "..." }

export async function PUT(req: Request, { params }) {
  const { workerId, tokenHash, error } = await verifyWorkerToken(req);
  if (error) return error;

  const { component, status, status_message } = await req.json();
  const vineId = params.id;

  const tableName = `vine_${component}`;
  await supabase.from(tableName)
    .update({ status, status_message })
    .eq("vine_id", vineId);

  // Recalculate vine overall status
  // ...
}
```

## Realtime subscriptions

The frontend subscribes to component table changes via Supabase Realtime:

```typescript
supabase.channel("vine-components")
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "vine_vpc", filter: `vine_id=eq.${vineId}` }, ...)
  .on("postgres_changes", { event: "UPDATE", schema: "public", table: "vine_eks", filter: `vine_id=eq.${vineId}` }, ...)
  // ...
  .subscribe();
```

This gives live updates as each component transitions: PENDING → CREATING → ACTIVE.
