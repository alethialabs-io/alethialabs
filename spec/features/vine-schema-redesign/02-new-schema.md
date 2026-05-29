# 02 — New Schema

## Design Principles

- **Singleton components** (1:1) — VPC, EKS: one per vine, own table, own status
- **Multi-instance components** (1:N) — databases, queues, topics, DynamoDB tables, ECR repos: many per vine, each row is an instance with its own status
- **Every component has `status` + `status_message`** — worker updates these as it provisions
- **Every component has `estimated_monthly_cost`** — calculated at config time via Infracost or estimates
- **Sensible defaults** — template repos, CIDR blocks, capacity units all have defaults
- **Field names match Terraform** — no more `enable_dns` → `acm_certificate_enable` translations
- **DNS hosted zones are read-only** — fetched from AWS, user selects, we don't create them
- **Existing values show in selectors** — the form queries component tables to show what already exists

## Component Status Lifecycle

```
PENDING → CREATING → ACTIVE → UPDATING → ACTIVE
                   → FAILED              → FAILED
ACTIVE → DESTROYING → DESTROYED
```

## Tables

### `vines` — the orchestrator

```sql
CREATE TABLE public.vines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL DEFAULT auth.uid(),
  vineyard_id UUID REFERENCES public.vineyards(id) ON DELETE SET NULL,
  cloud_identity_id UUID REFERENCES public.cloud_identities(id) ON DELETE SET NULL,

  project_name TEXT NOT NULL,
  environment_stage TEXT NOT NULL DEFAULT 'development'
    CHECK (environment_stage IN ('development', 'staging', 'production')),
  aws_region TEXT NOT NULL DEFAULT 'eu-west-1',
  aws_account_id TEXT,
  terraform_version TEXT NOT NULL DEFAULT '1.11.4',

  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'QUEUED', 'PROVISIONING', 'ACTIVE', 'FAILED', 'DESTROYING', 'DESTROYED')),

  estimated_monthly_cost FLOAT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### Singleton Components (1:1 per vine)

#### `vine_vpc` — VPC & Networking

```sql
CREATE TABLE public.vine_vpc (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL UNIQUE REFERENCES public.vines(id) ON DELETE CASCADE,

  provision_vpc BOOLEAN NOT NULL DEFAULT true,
  vpc_id TEXT,                              -- existing VPC ID if reusing
  vpc_cidr TEXT DEFAULT '10.0.0.0/16',
  single_nat_gateway BOOLEAN DEFAULT true,  -- false = one per AZ (HA)
  allowed_cidr_blocks TEXT[] DEFAULT '{}',

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CREATING','ACTIVE','UPDATING','FAILED','DESTROYING','DESTROYED')),
  status_message TEXT,
  estimated_monthly_cost FLOAT,             -- NAT Gateway: ~$32.85/mo

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `vine_eks` — Kubernetes Cluster

```sql
CREATE TABLE public.vine_eks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL UNIQUE REFERENCES public.vines(id) ON DELETE CASCADE,

  cluster_version TEXT DEFAULT '1.32',
  enable_karpenter BOOLEAN DEFAULT true,
  cluster_admins JSONB DEFAULT '[]'::jsonb,   -- [{username, groups[]}]
  instance_types TEXT[] DEFAULT '{t3.medium}',
  node_min_size INT DEFAULT 2,
  node_max_size INT DEFAULT 5,
  node_desired_size INT DEFAULT 2,

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CREATING','ACTIVE','UPDATING','FAILED','DESTROYING','DESTROYED')),
  status_message TEXT,
  estimated_monthly_cost FLOAT,             -- Control plane $73 + nodes
  cluster_name TEXT,                        -- populated after provisioning
  cluster_endpoint TEXT,                    -- populated after provisioning

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `vine_dns` — DNS & Certificates (read-only zone selection)

```sql
CREATE TABLE public.vine_dns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL UNIQUE REFERENCES public.vines(id) ON DELETE CASCADE,

  enabled BOOLEAN NOT NULL DEFAULT false,
  hosted_zone_id TEXT,                      -- selected from AWS (read-only list)
  domain_name TEXT,
  acm_certificate BOOLEAN DEFAULT false,
  cloudfront_waf BOOLEAN DEFAULT false,
  application_waf BOOLEAN DEFAULT false,

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CREATING','ACTIVE','UPDATING','FAILED','DESTROYING','DESTROYED')),
  status_message TEXT,
  estimated_monthly_cost FLOAT,             -- WAF: ~$5/mo per web ACL

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `vine_repositories` — Git Templates & Destinations

```sql
CREATE TABLE public.vine_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL UNIQUE REFERENCES public.vines(id) ON DELETE CASCADE,

  -- Infrastructure template (Terraform)
  env_template_repo TEXT NOT NULL DEFAULT 'git@github.com:itgix/adp-tf-envtempl-standard.git',
  env_template_branch TEXT DEFAULT 'v1.2.7',
  env_destination_repo TEXT,

  -- GitOps template (ArgoCD infrastructure services)
  gitops_template_repo TEXT NOT NULL DEFAULT 'git@github.com:itgix/adp-k8s-templ-argoinfrasvcs.git',
  gitops_template_branch TEXT DEFAULT 'v1.2.11',
  gitops_destination_repo TEXT,
  gitops_argocd_token TEXT,

  -- Applications template (optional)
  apps_template_repo TEXT,
  apps_template_branch TEXT,
  apps_destination_repo TEXT,
  apps_token TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### Multi-Instance Components (1:N per vine)

#### `vine_databases` — RDS Aurora instances

A vine can have multiple databases (e.g. app DB + analytics DB).

```sql
CREATE TABLE public.vine_databases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,                       -- user-friendly name: "app-db", "analytics"
  engine TEXT DEFAULT 'aurora-postgresql',
  engine_version TEXT DEFAULT '14.5',
  min_capacity FLOAT DEFAULT 0.5,           -- ACU
  max_capacity FLOAT DEFAULT 4,             -- ACU
  port INT DEFAULT 5432,
  backup_retention_days INT DEFAULT 7,
  iam_auth BOOLEAN DEFAULT false,

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CREATING','ACTIVE','UPDATING','FAILED','DESTROYING','DESTROYED')),
  status_message TEXT,
  estimated_monthly_cost FLOAT,             -- $0.12/ACU/hr * min_capacity * 730
  endpoint TEXT,                            -- populated after provisioning
  reader_endpoint TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `vine_caches` — ElastiCache Redis/Valkey instances

```sql
CREATE TABLE public.vine_caches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  engine TEXT DEFAULT 'redis'
    CHECK (engine IN ('redis', 'valkey')),
  node_type TEXT DEFAULT 'cache.t3.medium',
  num_cache_nodes INT DEFAULT 1,
  multi_az BOOLEAN DEFAULT false,
  allowed_cidr_blocks TEXT[] DEFAULT '{}',

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CREATING','ACTIVE','UPDATING','FAILED','DESTROYING','DESTROYED')),
  status_message TEXT,
  estimated_monthly_cost FLOAT,             -- ~$24.84/mo for t3.medium
  endpoint TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `vine_queues` — SQS Queues

```sql
CREATE TABLE public.vine_queues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  fifo BOOLEAN DEFAULT false,
  visibility_timeout INT DEFAULT 30,        -- seconds
  message_retention INT DEFAULT 345600,     -- seconds (4 days default)
  delay_seconds INT DEFAULT 0,

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CREATING','ACTIVE','UPDATING','FAILED','DESTROYING','DESTROYED')),
  status_message TEXT,
  estimated_monthly_cost FLOAT,             -- SQS is pay-per-request, minimal

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `vine_topics` — SNS Topics

```sql
CREATE TABLE public.vine_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  subscriptions JSONB DEFAULT '[]'::jsonb,  -- [{protocol, endpoint}]

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CREATING','ACTIVE','UPDATING','FAILED','DESTROYING','DESTROYED')),
  status_message TEXT,
  estimated_monthly_cost FLOAT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `vine_dynamodb_tables` — DynamoDB Tables

```sql
CREATE TABLE public.vine_dynamodb_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  table_type TEXT DEFAULT 'standard'
    CHECK (table_type IN ('standard', 'global')),
  hash_key TEXT NOT NULL,
  hash_key_type TEXT DEFAULT 'S'
    CHECK (hash_key_type IN ('S', 'N', 'B')),
  range_key TEXT,
  range_key_type TEXT
    CHECK (range_key_type IN ('S', 'N', 'B')),
  billing_mode TEXT DEFAULT 'PAY_PER_REQUEST'
    CHECK (billing_mode IN ('PAY_PER_REQUEST', 'PROVISIONED')),
  point_in_time_recovery BOOLEAN DEFAULT true,
  global_replicas TEXT[] DEFAULT '{}',      -- regions for global tables

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CREATING','ACTIVE','UPDATING','FAILED','DESTROYING','DESTROYED')),
  status_message TEXT,
  estimated_monthly_cost FLOAT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `vine_ecr_repos` — ECR Container Repositories

```sql
CREATE TABLE public.vine_ecr_repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  image_tag_mutability TEXT DEFAULT 'MUTABLE'
    CHECK (image_tag_mutability IN ('MUTABLE', 'IMMUTABLE')),
  scan_on_push BOOLEAN DEFAULT true,

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CREATING','ACTIVE','UPDATING','FAILED','DESTROYING','DESTROYED')),
  status_message TEXT,
  repository_url TEXT,                      -- populated after provisioning

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### `vine_secrets` — Secrets Manager Entries

```sql
CREATE TABLE public.vine_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vine_id UUID NOT NULL REFERENCES public.vines(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  generate BOOLEAN DEFAULT true,            -- auto-generate value
  length INT DEFAULT 32,
  special_chars BOOLEAN DEFAULT true,

  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CREATING','ACTIVE','UPDATING','FAILED','DESTROYING','DESTROYED')),
  status_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

### RLS Policies

All component tables use the same pattern — access scoped through the parent vine's `user_id`:

```sql
-- Template for all component tables:
ALTER TABLE public.vine_{component} ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own vine_{component}" ON public.vine_{component}
  FOR ALL
  USING (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()))
  WITH CHECK (vine_id IN (SELECT id FROM public.vines WHERE user_id = auth.uid()));
```

---

### Backward Compatibility View

```sql
CREATE VIEW public.vine_full AS
SELECT
  v.*,
  vpc.provision_vpc AS create_vpc, vpc.vpc_cidr, vpc.vpc_id AS selected_vpc_id,
  eks.cluster_version, eks.enable_karpenter, eks.cluster_admins,
  (SELECT MIN(d.min_capacity) FROM vine_databases d WHERE d.vine_id = v.id AND d.status != 'DESTROYED') AS db_min_capacity,
  (SELECT MAX(d.max_capacity) FROM vine_databases d WHERE d.vine_id = v.id AND d.status != 'DESTROYED') AS db_max_capacity,
  EXISTS(SELECT 1 FROM vine_databases d WHERE d.vine_id = v.id AND d.status != 'DESTROYED') AS create_rds,
  EXISTS(SELECT 1 FROM vine_caches c WHERE c.vine_id = v.id AND c.status != 'DESTROYED') AS enable_redis,
  dns.enabled AS enable_dns, dns.domain_name AS dns_main_domain, dns.hosted_zone_id AS dns_hosted_zone,
  dns.cloudfront_waf AS enable_cloudfront_waf,
  repos.env_template_repo, repos.env_template_branch AS env_template_repo_branch,
  repos.env_destination_repo AS env_git_repo,
  repos.gitops_template_repo, repos.gitops_template_branch AS gitops_template_repo_branch,
  repos.gitops_destination_repo, repos.gitops_argocd_token,
  repos.apps_template_repo AS applications_template_repo,
  repos.apps_template_branch AS applications_template_repo_branch,
  repos.apps_destination_repo AS applications_destination_repo,
  repos.apps_token AS gitops_app_token
FROM public.vines v
LEFT JOIN public.vine_vpc vpc ON vpc.vine_id = v.id
LEFT JOIN public.vine_eks eks ON eks.vine_id = v.id
LEFT JOIN public.vine_dns dns ON dns.vine_id = v.id
LEFT JOIN public.vine_repositories repos ON repos.vine_id = v.id;
```

---

### Cost Estimation

Each component table has `estimated_monthly_cost`. Calculated at config time:

| Component | Formula |
|-----------|---------|
| EKS control plane | $73/mo (standard), $438/mo (extended <1.30) |
| EKS nodes | instance_price * node_desired_size * 730 hrs |
| NAT Gateway | $32.85/mo (single), $32.85 * AZ_count (multi) |
| RDS Aurora | $0.12/ACU/hr * min_capacity * 730 |
| ElastiCache | instance_price * num_nodes * 730 |
| SQS | ~$0 (pay-per-request) |
| SNS | ~$0 (pay-per-request) |
| DynamoDB | $0 (on-demand), calculated if provisioned |
| WAF | $5/mo per web ACL + $1/mo per rule |
| ACM | $0 (free with AWS resources) |

The vine's `estimated_monthly_cost` is the sum of all component costs.

Future: integrate Infracost API for accurate per-resource estimates from the Terraform plan.
