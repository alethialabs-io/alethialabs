# User Flows

Six key journeys through the platform. These power the landing page's "How It Works" section and the pitch deck's demo narrative.

---

## Flow 1: First-Time Setup (Web)

**Who**: New user, no infrastructure yet.

```
1. Land on trellis.tovr.eu → public landing page
2. Click "Get Started" → /auth/signin
3. Sign in with GitHub / GitLab / Bitbucket / Google (Supabase Auth)
4. Post-auth redirect → /dashboard (empty state)
5. Dashboard prompts: "Connect a cloud provider"

6. Click "Add Integration" → /dashboard/integrations
7. Select cloud provider:
   ├── AWS → /dashboard/providers/aws
   │   └── Deploy CloudFormation template → creates GrapeProvisionerRole
   │   └── Paste Role ARN + External ID → connection test job queued
   │   └── Worker verifies access → cloud_identity created
   ├── GCP → /dashboard/providers/gcp
   │   └── Configure Workload Identity Federation pool
   │   └── Enter Project ID + Service Account email
   │   └── Connection test → cloud_identity created
   └── Azure → /dashboard/providers/azure
       └── Create App Registration with federated credential
       └── Enter Tenant ID + Subscription ID + Client ID
       └── Connection test → cloud_identity created

8. Connect Git provider:
   └── GitHub / GitLab / Bitbucket OAuth flow
   └── provider_token stored with refresh logic

9. Dashboard now shows:
   - Cloud provider: Connected ✓
   - Git provider: Connected ✓
   - Ready to plant a vine
```

**Time**: ~10 minutes (mostly CloudFormation/WIF setup in cloud console)

---

## Flow 2: Configure + Provision (Web)

**Who**: Authenticated user with cloud + git providers connected.

```
1. Dashboard → click "Plant a Vine" → /dashboard/plant

2. Fill 11-section guided form:
   ┌──────────────────────────────────────────────────────┐
   │ Section 1: Project Basics                            │
   │   Project name: api-backend                          │
   │   Environment: production                            │
   │   Region: eu-west-1  [provider-specific list]        │
   │   Cloud identity: [dropdown of verified identities]  │
   │   Terraform version: 1.7.4                           │
   │   Vineyard: production  [select or create]           │
   ├──────────────────────────────────────────────────────┤
   │ Section 2: Network                                   │
   │   ☑ Create new VPC                                   │
   │   CIDR: 10.0.0.0/16                                  │
   │   ☑ Single NAT gateway (cost savings)                │
   ├──────────────────────────────────────────────────────┤
   │ Section 3: Cluster                                   │
   │   Kubernetes: 1.31                                    │
   │   Instance types: m5.large, m5.xlarge                │
   │   Nodes: min 2, desired 3, max 10                    │
   │   ☑ Enable Karpenter (AWS) / Autopilot (GCP)        │
   ├──────────────────────────────────────────────────────┤
   │ Section 4: Databases                                 │
   │   + Add database                                     │
   │     Engine: Aurora PostgreSQL 16.4                    │
   │     Nodes: 2   Instance: db.r6g.large                │
   │     ☑ Multi-AZ                                       │
   ├──────────────────────────────────────────────────────┤
   │ Section 5: Caches                                    │
   │   + Add cache                                        │
   │     Engine: ElastiCache Redis                         │
   │     Node: cache.r6g.large   ☑ Multi-AZ              │
   ├──────────────────────────────────────────────────────┤
   │ Section 6: NoSQL                                     │
   │   + Add table                                        │
   │     Engine: DynamoDB                                  │
   │     Hash key: user_id (S)   Billing: PAY_PER_REQUEST │
   ├──────────────────────────────────────────────────────┤
   │ Section 7: Messaging                                 │
   │   + Add queue (SQS)   + Add topic (SNS)             │
   ├──────────────────────────────────────────────────────┤
   │ Section 8: DNS                                       │
   │   Domain: api.example.com                             │
   │   Hosted zone: example.com (Z1234...)                │
   │   ☑ CloudFront WAF   ☑ ACM Certificate              │
   ├──────────────────────────────────────────────────────┤
   │ Section 9: Secrets                                   │
   │   + Add secret                                       │
   │     Name: DATABASE_URL   Value: ••••••••             │
   ├──────────────────────────────────────────────────────┤
   │ Section 10: Container Registry                       │
   │   ☑ Enable ECR   ☑ Vulnerability scanning           │
   ├──────────────────────────────────────────────────────┤
   │ Section 11: Repositories                             │
   │   Infra repo: github.com/org/infra                   │
   │   App repo: github.com/org/api-backend               │
   └──────────────────────────────────────────────────────┘

   Cost Sidebar (updates in real-time):
   ┌────────────────────┐
   │ Estimated Monthly   │
   │ $847.23/mo         │
   │                    │
   │ EKS Cluster  $219  │
   │ Aurora DB    $412  │
   │ ElastiCache  $156  │
   │ NAT Gateway   $32  │
   │ DNS            $1  │
   │ Other          $27 │
   └────────────────────┘

3. Submit → vine row created (status: DRAFT)
   └── Component rows created (vine_network, vine_cluster, vine_database, ...)
   └── PLAN job queued

4. Worker claims PLAN job:
   └── Assumes cloud credentials
   └── Generates Terraform from vine config
   └── terraform plan → 47 resources to create
   └── Infracost analysis → $847.23/mo
   └── Streams logs to /dashboard/jobs/[id]

5. User reviews plan:
   └── Resource tree: VPC, subnets, EKS, node groups, Aurora, ...
   └── Cost breakdown per resource
   └── Click "Apply"

6. DEPLOY job queued:
   └── terraform apply (12-15 min for full stack)
   └── kubectl: install ArgoCD
   └── ArgoCD: sync infra-services application
   └── Vine status → ACTIVE

7. Vine detail page shows:
   └── Per-component status (all green ✓)
   └── Cluster endpoint, ArgoCD URL
   └── Monthly cost tracking
```

**Time**: ~5 minutes to configure, ~15 minutes to provision

---

## Flow 3: CLI Workflow

**Who**: Developer who prefers the terminal.

```
1. Install and authenticate:
   $ brew install grape
   $ grape login
     → Browser opens /cli/login?device_code=ABC&verification_code=123456
     → User approves in browser
     → CLI receives refresh token
     → Token saved to ~/.config/grape/auth.json

2. Create workspace:
   $ grape vineyard create "production"
     ? Select cloud identity: aws-prod (123456789012)
     ✓ Vineyard "production" created

3. Design infrastructure (6-step TUI wizard):
   $ grape config create
     Step 1/6: Vineyard & Basics
       Vineyard: production
       Name: api-backend
       Environment: production
       Region: eu-west-1
       Provider: aws

     Step 2/6: Platform
       Kubernetes: 1.31
       Instance types: m5.large
       Nodes: min 2, desired 3, max 10

     Step 3/6: Repositories
       Git provider: GitHub
       Infra repo: org/infra
       App repo: org/api-backend

     Step 4/6: Network & Advanced
       VPC CIDR: 10.0.0.0/16
       NAT: single
       DNS: api.example.com

     Step 5/6: Data Services
       Database: Aurora PostgreSQL 16.4 (db.r6g.large x2)
       Cache: ElastiCache Redis (cache.r6g.large)

     Step 6/6: Review
       Estimated cost: $847.23/mo
       ✓ Configuration saved

4. Deploy:
   $ grape harvest
     ? Select vineyard: production
     ? Select vine: api-backend (eu-west-1)
     ? Select worker: prod-worker (ONLINE)
     ✓ DEPLOY job #42 queued

5. Monitor in Trellis web dashboard (or future: grape logs #42)

6. Teardown when done:
   $ grape destroy
     ? Select vineyard: production
     ? Confirm destroy "api-backend"? (y/N): y
     ✓ DESTROY job #43 queued
```

---

## Flow 4: Worker Lifecycle

**Who**: Platform engineer setting up the execution layer.

```
1. Register worker:
   $ grape worker register --name "prod-worker" --mode cloud-hosted
     ✓ Worker registered (ID: wrk_abc123)
     ✓ Credentials saved to ~/.config/grape/worker.json

   OR: Add via Trellis UI → /dashboard/workers → "Add Worker"
   └── Choose: Cloud-managed (Fargate) or Self-hosted
   └── For cloud-managed: select region, CPU, memory
   └── DEPLOY_WORKER job queued → worker infrastructure provisioned

2. Worker starts:
   $ grape worker start
     ✓ Connected to Trellis
     ✓ Heartbeat: every 30s
     ✓ Polling for jobs: every 10s

3. Job execution cycle:
   ┌─────────────────────────────────────────────┐
   │  Poll: GET /api/jobs/claim                  │
   │  ├── No job → sleep 10s → retry             │
   │  └── Job claimed:                           │
   │      ├── Read cloud_identity from config     │
   │      ├── Assume credentials (per provider)   │
   │      ├── Execute job:                        │
   │      │   ├── terraform init (S3 backend)     │
   │      │   ├── terraform plan / apply / destroy│
   │      │   ├── helm install (ArgoCD)           │
   │      │   └── kubectl apply (manifests)       │
   │      ├── Stream logs (batched)               │
   │      └── Report status: SUCCESS / FAILED     │
   └─────────────────────────────────────────────┘

4. Health monitoring:
   └── Trellis dashboard: /dashboard/workers
   └── Green dot = ONLINE (heartbeat received within 60s)
   └── Yellow dot = DRAINING (not accepting new jobs)
   └── Red dot = OFFLINE (heartbeat missed)
   └── Stale job recovery: if worker goes offline mid-job, job requeued

5. Teardown:
   └── DESTROY_WORKER job removes Fargate task + IAM roles
   └── Or: grape worker start --drain → finish current job, stop polling
```

---

## Flow 5: Teardown

**Who**: User decommissioning infrastructure.

```
1. Trigger destroy:
   ├── Web: Vine detail page → "Destroy" button → confirmation modal
   └── CLI: grape destroy → interactive selection → confirmation prompt

2. DESTROY job queued:
   └── Worker claims job

3. Execution:
   ├── Disable ArgoCD self-healing (prevent reconciliation during teardown)
   ├── Drain load balancers and ingress controllers
   ├── terraform destroy:
   │   ├── Remove DNS records
   │   ├── Delete databases (with final snapshot if configured)
   │   ├── Delete caches
   │   ├── Delete messaging queues/topics
   │   ├── Remove EKS/GKE/AKS cluster
   │   ├── Delete NAT gateways
   │   └── Delete VPC/VNet
   ├── Clean up:
   │   ├── Remove Terraform state from S3
   │   ├── Delete local workspace (if CLI)
   │   └── Optionally delete generated Git repos
   └── Vine status → DESTROYED

4. Vine remains in Trellis as historical record (can be deleted manually)
```

---

## Flow 6: Multi-Cloud Duplication

**Who**: User replicating infrastructure across clouds.

```
1. Existing vine: api-backend (AWS, eu-west-1, ACTIVE)

2. Vine detail page → "Duplicate" dropdown:
   ├── Quick Copy → creates identical DRAFT vine in same vineyard
   └── Duplicate & Edit → opens Plant a Vine form pre-filled with existing config

3. In the form:
   └── Switch provider ribbon: AWS → GCP
   └── Form auto-translates:
       ├── EKS → GKE
       ├── Aurora → Cloud SQL
       ├── ElastiCache → Memorystore
       ├── DynamoDB → Firestore
       ├── SQS → Pub/Sub
       ├── Route 53 → Cloud DNS
       ├── ECR → Artifact Registry
       └── Secrets Manager → Secret Manager
   └── Region updates to GCP regions
   └── Cloud identity selector shows GCP identities
   └── Instance types map to GCP equivalents

4. Submit → new vine in GCP
5. Harvest → infrastructure provisioned in Google Cloud

Result: Same logical application, two cloud providers, managed from one dashboard.
```
