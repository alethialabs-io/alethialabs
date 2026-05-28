# Grape CLI — Demo & Testing Flow

Build the binary first:

```bash
cd apps/grape && go build -o bin/grape . && export PATH="$PWD/bin:$PATH"
```

Verify it runs:

```bash
grape --help
```

---

## Part 1: Config Validation (no network needed)

These test the modernized config parsing, validation, and tfvars generation — all offline.

### 1a. Load and validate a good config

```bash
# This exercises the expanded InstallerConfig (50+ fields),
# go-playground/validator, and .git suffix normalization.
grape deploy --config-file ../../spec/features/fixtures/configs/demo-mini.yml --dry-run --create-state-bucket-only 2>&1 || true
```

Expected: should get past config loading and fail at the AWS S3 step (no credentials). The point is to confirm config parsing + validation succeeds.

### 1b. Validate the full gda config (nested fields)

```bash
grape deploy --config-file ../../spec/features/fixtures/configs/gda-config.yaml --dry-run --create-state-bucket-only 2>&1 || true
```

Expected: same — config loads fine, `ses_queues_topics`, `eks_access_entries`, `custom_secrets` all parse. Fails at AWS.

### 1c. Validation catches missing fields

Create a broken config:

```bash
cat > /tmp/broken-config.yaml << 'EOF'
project_name: test
region: eu-west-1
# missing: environment, aws_account_id, terraform_ver, repos
EOF

grape deploy --config-file /tmp/broken-config.yaml --dry-run 2>&1 || true
```

Expected: **validation error** listing missing required fields (Environment, AwsAccountID, TerraformVer, etc.) — not a cryptic Terraform failure 15 minutes later.

### 1d. Validation catches name length violations

```bash
cat > /tmp/longname-config.yaml << 'EOF'
project_name: thisprojectnameiswaytoolong
environment: development
region: eu-west-1
aws_account_id: "123456789012"
terraform_ver: "1.11.4"
env_template_repo: "git@github.com:example/env.git"
env_template_repo_branch: main
env_git_repo: "git@github.com:example/client.git"
gitops_template_repo: "git@github.com:example/gitops.git"
gitops_destination_repo: "https://github.com/example/dest.git"
EOF

grape deploy --config-file /tmp/longname-config.yaml --dry-run 2>&1 || true
```

Expected: error about `project_name exceeds max length 15`.

### 1e. allow_long_names relaxes the constraint

```bash
cat > /tmp/longname-allowed.yaml << 'EOF'
project_name: thisprojectnameislong
environment: development
region: eu-west-1
aws_account_id: "123456789012"
terraform_ver: "1.11.4"
allow_long_names: true
env_template_repo: "git@github.com:example/env.git"
env_template_repo_branch: main
env_git_repo: "git@github.com:example/client.git"
gitops_template_repo: "git@github.com:example/gitops.git"
gitops_destination_repo: "https://github.com/example/dest.git"
EOF

grape deploy --config-file /tmp/longname-allowed.yaml --dry-run --create-state-bucket-only 2>&1 || true
```

Expected: passes validation (limit raised to 25), fails at AWS.

### 1f. Invalid CIDR is caught

```bash
cat > /tmp/bad-cidr.yaml << 'EOF'
project_name: test
environment: dev
region: eu-west-1
aws_account_id: "123456789012"
terraform_ver: "1.11.4"
env_template_repo: "git@github.com:example/env.git"
env_template_repo_branch: main
env_git_repo: "git@github.com:example/client.git"
gitops_template_repo: "git@github.com:example/gitops.git"
gitops_destination_repo: "https://github.com/example/dest.git"
vpc_cidr: "not-a-cidr"
EOF

grape deploy --config-file /tmp/bad-cidr.yaml --dry-run 2>&1 || true
```

Expected: validation error on `VPCCIDR: failed on 'cidrv4'`.

---

## Part 2: Unit Tests

Run the full test suite to verify all modernization changes:

```bash
cd apps/grape && go test ./... -v -count=1
```

Key tests to watch:
- `TestLoadFixtureConfigDemoMini` — parses the real demo config, checks all typed fields
- `TestLoadFixtureConfigGda` — parses the full gda config with nested structures
- `TestValidationRejectsMissingFields` — catches missing required fields
- `TestValidationNameLengthWithoutAllowLong` — enforces name length limits
- `TestValidationGitSuffixNormalization` — verifies `.git` is appended to bare URLs
- `TestOverrideTfvarsWritesTypedJSONFromRawConfig` — tfvars JSON generation
- `TestGenerateBackendConfig` — S3 backend naming convention

---

## Part 3: Authentication & Online Commands

These require network access to your Trellis instance.

### 3a. Login

```bash
grape login
```

Opens browser for device-code authentication. After login, credentials are stored at `~/.config/grape/credentials.json`.

### 3b. List vineyards

```bash
grape vineyard list
```

Interactive table. Press `s` to sort, `q` to quit.

### 3c. List configurations

```bash
grape config list
```

Interactive table showing all configurations.

### 3d. Get a specific config

```bash
grape config get <project_name>
```

Shows formatted details (AWS, Network, Database, Security sections).

### 3e. Pull a config as YAML

```bash
grape config pull <project_name> -o pulled-config.yaml
cat pulled-config.yaml
```

Exports a legacy-compatible YAML file from Trellis. You can then feed it back:

```bash
grape deploy --config-file pulled-config.yaml --dry-run --create-state-bucket-only 2>&1 || true
```

This round-trips: Trellis → YAML → validation → tfvars generation.

### 3f. Create a vineyard

```bash
grape vineyard create my-demo-vineyard -d "Demo vineyard for testing"
```

### 3g. Create a configuration (interactive)

```bash
grape config create
```

Walk through the interactive form. Fill in test values. This creates a vine in Trellis.

### 3h. List clusters

```bash
grape clusters list
```

Shows connected clusters with status indicators.

---

## Part 4: Deploy (dry-run, requires AWS credentials)

This tests the full deploy pipeline — Terraform init, plan, git cloning, infra-facts generation — without actually provisioning.

### 4a. Deploy with a local config file (dry-run)

```bash
# Make sure you have AWS credentials configured
# for the account in the config file
grape deploy --config-file ../../spec/features/fixtures/configs/demo-mini.yml \
  --dry-run \
  --aws-profile <your-profile>
```

This exercises:
- Config loading and validation (Item 5)
- AWS profile wiring — now actually used (Item 1)
- Terraform-exec SDK — downloads terraform, runs init + plan (Item 6)
- JSON plan generation via ShowPlanJSON (Item 9)
- Infracost analysis with JSON plan (Item 9)
- infra-facts.yaml with correct field names (Item 3)

Check the output for:
- `Initializing Terraform...` (terraform-exec SDK)
- `Generating plan JSON...` (new ShowPlanJSON method)
- `Saved infra-facts.yaml to temp/infra-facts.yaml`

Then inspect the generated files:

```bash
# Check infra-facts has the correct field names
# (region, environment — not aws_region, environment_stage)
cat temp/infra-facts.yaml

# Check tfvars JSON was generated correctly
cat git/client_repo/terraform.tfvars.json
```

### 4b. Deploy from Trellis API (dry-run)

```bash
grape deploy <project_name> --dry-run --aws-profile <your-profile>
```

Same flow but fetches config from the Trellis API instead of a local file. Creates a deployment record and streams logs.

### 4c. State bucket creation (with hardened security)

```bash
grape deploy --config-file ../../spec/features/fixtures/configs/demo-mini.yml \
  --create-state-bucket-only \
  --aws-profile <your-profile>
```

This creates an S3 bucket with the full security baseline (Item 4):
- Public access blocked
- SSE-S3 encryption enabled
- Versioning enabled
- BucketOwnerEnforced ownership

Verify in the AWS Console (S3 → bucket → Properties/Permissions) that all four security settings are applied.

---

## Part 5: Bootstrap & Destroy (requires AWS credentials, provisions real infrastructure)

**WARNING: This provisions real AWS resources (EKS cluster, VPC). Costs ~$3-5/hour.**

### 5a. Bootstrap

```bash
grape bootstrap
```

Interactive prompts for vineyard, environment, region, and VPC. Provisions base infrastructure and installs ArgoCD.

### 5b. Destroy

```bash
grape destroy
```

Tears down the bootstrapped environment.

---

## Part 6: Edge Cases & Error Handling

### 6a. Git clone failure (bounded retry)

The bounded retry is exercised when a destination repo doesn't exist. During `grape deploy`, if a git clone fails:
- You'll be prompted to create the repo (if authenticated)
- Max 3 retries with exponential backoff
- No infinite recursion

### 6b. AWS profile mismatch

```bash
grape deploy --config-file ../../spec/features/fixtures/configs/demo-mini.yml \
  --dry-run \
  --aws-profile nonexistent-profile
```

Expected: AWS SDK error about the profile not being found — proves the profile is actually being used (Item 1).

### 6c. Helm multiple values files

During a full deploy (not dry-run), the Helm install step now automatically includes `values.generated.yaml` if it exists alongside `values.yaml`. Check the helm command output for multiple `-f` flags.

### 6d. Missing dependencies

```bash
# Temporarily rename a required tool to test preflight checks
# (don't actually do this on a production machine)
grape deploy --config-file ../../spec/features/fixtures/configs/demo-mini.yml --dry-run
```

If `aws`, `kubectl`, or `helm` are not in PATH, the preflight check fails immediately with a clear message listing missing tools.

---

## Quick Smoke Test (fastest way to verify changes)

If you just want to confirm everything compiles and the config pipeline works:

```bash
cd apps/grape
go build -o bin/grape .
go test ./... -v -count=1
bin/grape deploy --config-file ../../spec/features/fixtures/configs/demo-mini.yml --dry-run --create-state-bucket-only 2>&1 | head -20
bin/grape deploy --config-file /tmp/broken-config.yaml --dry-run 2>&1 | head -20
```
