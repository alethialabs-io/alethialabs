# Worker Provisioning — Design Specification

The platform runs a cloud-hosted Fargate worker that provisions infrastructure for users. Users connect their AWS account via CloudFormation, configure what they want in Trellis, and click provision. The worker handles everything — Terraform, Git, Helm, kubectl — and streams logs back in real time.

## Documents

| File | Purpose |
|------|---------|
| [01-user-flow.md](./01-user-flow.md) | End-to-end user journey: connect AWS → configure → harvest → infrastructure |
| [02-worker-lifecycle.md](./02-worker-lifecycle.md) | Worker states, heartbeat, job execution, stale recovery |
| [03-cli-commands.md](./03-cli-commands.md) | CLI commands and their behavior |
| [04-error-handling.md](./04-error-handling.md) | Preflight checks, failure modes, recovery, monitoring |
| [05-implementation-tracker.md](./05-implementation-tracker.md) | What's done, what's remaining, priority order |
| [06-e2e-test-plan.md](./06-e2e-test-plan.md) | Step-by-step E2E test procedure |

## MVP Scope

**Cloud-hosted worker first.** One central worker in Alethia's account (`787587782604`) provisions into user accounts via cross-account IAM roles. Self-hosted workers are phase 2.

## Key Architecture

```
User's AWS Account                     Alethia's AWS Account (787587782604)
┌─────────────────────┐                ┌─────────────────────────────────┐
│ AlethiaProvisionerRole│◄──AssumeRole───│ Fargate Worker                  │
│ (AdministratorAccess│                │ (polls Trellis, executes jobs)  │
│  External ID guard) │                │                                 │
│                     │                │ ECR repo (alethia:latest)         │
│ VPC, EKS, RDS, etc.│                │ CloudWatch logs                 │
│ (provisioned by     │                └─────────────────────────────────┘
│  the worker)        │                           │
└─────────────────────┘                           │ HTTPS
                                                  ▼
                                       ┌─────────────────────────────────┐
                                       │ Trellis (Vercel + Supabase)     │
                                       │ - provision_jobs queue          │
                                       │ - job_logs (Realtime)           │
                                       │ - cloud_identities              │
                                       │ - configurations                │
                                       └─────────────────────────────────┘
```
