# 07 — Template Strategy

## Current state

The infrastructure Terraform templates live in **two places**:

1. **`packages/templates/`** — the full set of .tf files (networking, eks, rds, sqs, dynamodb, ecr, waf, etc.) already in this repo
2. **Private itgix GitHub modules** — the templates reference private Terraform modules via SSH:
   - `git@github.com:itgix/tf-module-eks.git` (v1.0.0)
   - `git@github.com:itgix/tf-module-rds.git` (v1.0.1)
   - `git@github.com:itgix/tf-module-redis.git` (v1.0.0)
   - `git@github.com:itgix/tf-module-ecr.git` (v1.0.0)
   - `git@github.com:itgix/tf-module-sqs-sns.git` (v1.0.0)
   - `git@github.com:itgix/tf-module-wafv2.git` (v1)
   - `git@github.com:itgix/tf-module-acm.git` (v1.0.1)
   - `git@github.com:itgix/tf-module-dynamodb.git`
   - `git@github.com:itgix/tf-module-awssm-passgen.git` (v1.0.0)

The worker needs access to these during `terraform init` to download the modules.

## Strategy: Embed templates, provide module access via deploy key

### Step 1: Embed `packages/templates/` into the worker image

Add `packages/templates/` to the Grape binary's embedded assets:

```go
// apps/grape/internal/assets/embed.go
//go:embed all:terraform/seed
//go:embed all:terraform/templates   // NEW — the full infrastructure templates
//go:embed all:helm/tendril
var Assets embed.FS
```

Copy `packages/templates/` → `apps/grape/internal/assets/terraform/templates/` at build time (in the Dockerfile or as a pre-build step).

The worker extracts these to a workspace directory and runs Terraform from there.

### Step 2: Give the worker SSH access to private modules

The private `itgix/tf-module-*` repos are referenced in the templates' `source` fields. During `terraform init`, Terraform clones them via SSH.

Options:
1. **GitHub deploy key** — generate an SSH key, add it as a deploy key on each module repo. Store the private key in AWS Secrets Manager, inject into the Fargate container.
2. **GitHub App installation token** — create a GitHub App, install it on the itgix org, generate short-lived tokens. More complex but more secure.
3. **Mirror modules into this repo** — copy the module source into `packages/modules/` and change the template `source` references to local paths. No external access needed. **Simplest for the thesis.**

### Recommendation for MVP: Mirror modules locally

For the thesis, option 3 is the fastest path:

```
packages/
  templates/          # Terraform root module (.tf files)
  modules/            # Terraform child modules (mirrored from itgix repos)
    eks/
    rds/
    redis/
    ecr/
    sqs-sns/
    wafv2/
    acm/
    dynamodb/
    awssm-passgen/
  charts/             # Helm charts
    portal/
    tendril/
```

Change template `source` references from:
```hcl
module "eks" {
  source = "git::git@github.com:itgix/tf-module-eks.git?ref=v1.0.0"
}
```
to:
```hcl
module "eks" {
  source = "./modules/eks"
}
```

This eliminates all external dependencies. The worker image contains everything.

### For production: deploy key

Long-term, keep modules in separate repos for independent versioning. Use a GitHub deploy key stored in Secrets Manager, injected into the Fargate container at startup:

```dockerfile
# In the container entrypoint, before starting the worker:
# 1. Fetch SSH key from Secrets Manager
# 2. Write to ~/.ssh/id_rsa
# 3. Add github.com to known_hosts
# 4. Start worker
```

## How the worker uses templates

1. Worker claims a DEPLOY job
2. Extracts `packages/templates/` to a workspace: `~/.grape/workspaces/{project}-{env}/`
3. Generates `terraform.tfvars.json` from the vine's component tables (via config_snapshot)
4. Runs `terraform init` → `terraform plan` → `terraform apply`
5. Parses outputs (cluster endpoint, RDS endpoint, etc.)
6. Updates component statuses and populates output fields (endpoint URLs)

## Template versioning

Currently the templates are versioned via Git (the `env_template_repo_branch` field). With embedded templates, versioning is tied to the Docker image version.

When you update `packages/templates/`, rebuild and push the Docker image → the worker picks up the new templates on next deployment.

For more granular versioning (different template versions per vine), we could tag Docker images with template versions and let the vine specify which image/version to use. But that's post-MVP.
