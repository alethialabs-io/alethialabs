# 03 — CLI Commands

## New Commands

### `alethia runner register`

**Purpose:** Register a runner in Alethia and deploy Fargate infrastructure in one shot.

**Interactive flow:**
```
? Runner name: my-fargate-runner
? Mode: Self-hosted
? AWS Region: Europe (Ireland) [eu-west-1]
? VPC: vpc-0abc123 (10.0.0.0/16) - main [Default]
? Subnets: subnet-0aaa (eu-west-1a, public), subnet-0bbb (eu-west-1b, public)

Preflight checks...
  ✓ AWS credentials valid (account 787587782604)
  ✓ Docker daemon running
  ✓ Terraform >= 1.5 available

Registering runner with Alethia...
  ✓ Runner ID:    b189fccc-38e3-...
  ✓ Runner Token: 5791f8a908...

  ⚠ Save these credentials — the token cannot be recovered.

Deploying Fargate infrastructure...
  ✓ ECR repository created
  ✓ Building Docker image... (this may take a minute)
  ✓ Pushing to ECR...
  ✓ ECS cluster + service created
  ✓ IAM roles configured
  ✓ Runner token stored in Secrets Manager

Waiting for runner to come online...
  ✓ ECS task RUNNING
  ✓ First heartbeat received — runner is ONLINE

✓ Runner "my-fargate-runner" is ready. Queue work with:
    alethia spec apply
```

**Flags (override interactive):**
- `--name` — runner name
- `--mode` — self-hosted / cloud-hosted
- `--region` — AWS region
- `--vpc-id` — VPC ID
- `--subnet-ids` — comma-separated subnet IDs

**Preflight checks:**
1. `aws sts get-caller-identity` — valid credentials
2. `docker info` — Docker daemon running
3. `terraform version` — installed and >= 1.5
4. Alethia reachable — HTTP GET to health endpoint

### `alethia runner status`

**Purpose:** Show runner health and recent jobs.

```
Runner: my-fargate-runner (b189fccc-38e3-...)
Mode:   self-hosted
Status: ONLINE (last heartbeat 12s ago)
Region: eu-west-1

Recent Jobs:
  TYPE       STATUS      CREATED      DURATION
  BOOTSTRAP  SUCCESS     2h ago       14m 32s
  DEPLOY     PROCESSING  5m ago       —
  DEPLOY     QUEUED      just now     —
```

### `alethia runner destroy`

**Purpose:** Tear down runner Fargate infrastructure and deregister.

```
? Are you sure you want to destroy runner "my-fargate-runner"? This removes all Fargate resources. (y/N)

Destroying Fargate infrastructure...
  ✓ ECS service stopped
  ✓ Task definition deregistered
  ✓ ECR repository deleted
  ✓ IAM roles removed
  ✓ Secrets Manager secret deleted
  ✓ CloudWatch log group removed
  ✓ Runner deregistered from Alethia

✓ Runner "my-fargate-runner" destroyed.
```

### `alethia runner list`

**Purpose:** List all registered runners.

```
NAME                  MODE          STATUS    REGION        LAST HEARTBEAT
my-fargate-runner     self-hosted   ONLINE    eu-west-1     12s ago
staging-runner        self-hosted   OFFLINE   us-east-1     3h ago
```

## Modified Commands

### `alethia spec apply` (unchanged)

Already works correctly — queues jobs to the runner. No changes needed.

### `alethia bootstrap` (deprecated)

Change to print:
```
⚠ `alethia bootstrap` is deprecated.

Bootstrap is now handled by your provisioning runner.
Use `alethia spec apply` and select "Bootstrap new cluster" as the target.

If you don't have a runner yet, run:
    alethia runner register
```

Keep the `--queue` flag working as a compatibility shim (it already queues a BOOTSTRAP job).

### `alethia deploy` (legacy, keep as-is)

The legacy deploy command stays for backward compatibility with local provisioning. No changes.

## Command Tree

```
alethia
├── login              — authenticate with Alethia
├── logout             — clear auth token
├── runner
│   ├── register       — [NEW] register + deploy Fargate
│   ├── start          — [EXISTING] start runner locally (for development/Docker)
│   ├── status         — [NEW] show runner health
│   ├── list           — [NEW] list all runners
│   └── destroy        — [NEW] tear down runner infrastructure
├── deploy            — queue a provisioning job (DEPLOY/BOOTSTRAP)
├── provision          — alias for deploy
├── bootstrap          — [DEPRECATED] prints deprecation notice
├── deploy             — [LEGACY] local provisioning
├── destroy            — tear down a bootstrapped environment
├── zone           — manage zones
├── clusters           — manage clusters
└── config             — manage configurations
```
