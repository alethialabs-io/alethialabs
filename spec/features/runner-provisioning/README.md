# Runner Provisioning — Design Specification

The platform runs a cloud-hosted Fargate runner that provisions infrastructure for users. Users connect their AWS account via CloudFormation, configure what they want in Alethia, and click provision. The runner handles everything — Terraform, Git, Helm, kubectl — and streams logs back in real time.

## Documents

| File | Purpose |
|------|---------|
| [01-user-flow.md](./01-user-flow.md) | End-to-end user journey: connect AWS → configure → deploy → infrastructure |
| [02-runner-lifecycle.md](./02-runner-lifecycle.md) | Runner states, heartbeat, job execution, stale recovery |
| [03-cli-commands.md](./03-cli-commands.md) | CLI commands and their behavior |
| [04-error-handling.md](./04-error-handling.md) | Preflight checks, failure modes, recovery, monitoring |
| [05-implementation-tracker.md](./05-implementation-tracker.md) | What's done, what's remaining, priority order |
| [06-e2e-test-plan.md](./06-e2e-test-plan.md) | Step-by-step E2E test procedure |

## MVP Scope

**Cloud-hosted runner first.** One central runner in Alethia's account (`787587782604`) provisions into user accounts via cross-account IAM roles. Self-hosted runners are phase 2.

## Key Architecture

```
User's AWS Account                     Alethia's AWS Account (787587782604)
┌─────────────────────┐                ┌─────────────────────────────────┐
│ AlethiaProvisionerRole│◄──AssumeRole───│ Fargate Runner                  │
│ (AdministratorAccess│                │ (polls Alethia, executes jobs)  │
│  External ID guard) │                │                                 │
│                     │                │ ECR repo (alethia:latest)         │
│ VPC, EKS, RDS, etc.│                │ CloudWatch logs                 │
│ (provisioned by     │                └─────────────────────────────────┘
│  the runner)        │                           │
└─────────────────────┘                           │ HTTPS
                                                  ▼
                                       ┌─────────────────────────────────┐
                                       │ Alethia (console + Postgres + S3)     │
                                       │ - provision_jobs queue          │
                                       │ - job_logs (Realtime)           │
                                       │ - cloud_identities              │
                                       │ - configurations                │
                                       └─────────────────────────────────┘
```
