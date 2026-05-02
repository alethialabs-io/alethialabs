# Architecture Design Document: Viticulture Themed Infrastructure System

**Version:** 2.0  
**Status:** Active  
**Context:** Monorepo (Next.js, Go, Terraform)

## 1. Executive Summary
The system provides a centralized control plane (Trellis) and a remote execution agent (Tendril) for managing distributed infrastructure. Adopting a Viticulture theme, the system organizes infrastructure into **Vineyards** (logical environments) and **Vines** (specific configurations). The provisioning lifecycle is called a **Harvest**, executed by the **Tendril** agent within the user's environment. This architecture ensures that the Control Plane (Trellis) never needs to store sensitive cloud credentials.

## 2. Core Concepts & Terminology

*   **Trellis (Control Plane):** The Next.js web application and Supabase backend. It acts as the configuration builder, authentication provider, and dashboard.
*   **Grape (CLI):** The Go-based command-line tool developers use to interact with the platform.
*   **Vineyard:** A logical boundary or environment (e.g., an AWS account or organization unit).
*   **Vine:** A declarative infrastructure configuration assigned to a specific Vineyard.
*   **Harvest:** A provisioning execution (deployment) of a Vine.
*   **Tendril (Agent):** An autonomous Go binary running inside the user's remote environment (AWS EKS) that executes the Harvest and streams logs.

## 3. High-Level Topology

The system is strictly divided into two security zones:

### 3.1 The Trellis Control Plane
*   **Stack:** Next.js (Web), Supabase (Auth/DB/Realtime).
*   **Responsibility:** Persists Vine configurations, manages user authentication, and coordinates Harvests via the database message broker. Does **not** store AWS credentials.

### 3.2 The Remote Environment (Data Plane)
*   **Location:** User's AWS VPC (EKS Cluster).
*   **Responsibility:** The execution environment where `grape bootstrap` creates the base cluster and installs the Tendril agent. The Tendril agent executes `grape provision` instructions by reading Vines and running the resulting Harvests.

## 4. The Viticulture Workflow

### Step 1: Authentication
User authenticates via Grape CLI or Trellis Web Portal using Supabase Auth (`grape login`).

### Step 2: Configuration (Planting a Vine)
User creates a configuration (a **Vine**) and assigns it to a **Vineyard** via the Trellis interface or Grape CLI.

### Step 3: Bootstrapping (`grape bootstrap`)
User runs `grape bootstrap` from the CLI.
*   This command deploys a base EKS cluster and installs the **Tendril** agent using AWS CloudFormation.
*   **Security:** This is executed locally from the user's machine/CI, utilizing their local AWS credentials. Trellis never stores or sees these credentials.

### Step 4: Provisioning (`grape provision` / Running a Harvest)
User runs `grape provision`.
*   This triggers a **Harvest** on a specific **Vine**.
*   The Tendril agent, polling for instructions, reads the requested Vine configuration.
*   Tendril provisions everything checked off in that Vine (applying Terraform/Helm).

### Step 5: Log Management & Feedback
*   During the Harvest, execution logs (stdout/stderr) are managed and streamed by the Tendril agent running on the EKS cluster.
*   Logs are pushed back to the Trellis database, allowing users to view real-time Harvest progress via the web UI.

## 5. Security Architecture
*   **Zero-Credential Control Plane:** Trellis does not store AWS credentials. Infrastructure bootstrapping is performed client-side (`grape bootstrap`), keeping sensitive access scoped to the user's environment.
*   **Pull-Based Agent:** The Tendril agent makes outbound connections to Trellis to pull Harvest instructions and push logs. No ingress ports are exposed on the user's cluster.