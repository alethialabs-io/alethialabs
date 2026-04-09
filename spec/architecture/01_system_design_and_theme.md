# System Design & The Viticulture Architecture

## 1. Executive Summary
The system has been restructured around a new **Viticulture** architectural theme. This theme provides a cohesive, memorable naming convention for the components of our Enterprise Application Development Platform.

This document outlines the system design, the unified terminology, the visual topology concept, and the current state of implementation.

---

## 2. The Unified Viticulture Terminology Dictionary

To prevent confusing overlapping terms like "Project / Vineyard" and "Configuration / Vine", we strictly enforce these definitions across the UI, CLI, and documentation:

| Domain Term | Standard Counterpart | Description |
| :--- | :--- | :--- |
| **Trellis** | Web Control Plane | The central Next.js dashboard, configuration manager, and state store (Supabase). |
| **Grape** | CLI Tool | The primary interaction tool for developers/ops to manage the system. |
| **Vineyard** | Project / Workspace | A logical grouping of infrastructure. A user can have multiple Vineyards. |
| **Vine** | Configuration | The declarative infrastructure state (e.g., AWS VPCs, EKS specs, DB sizes). You *Plant* a Vine. |
| **Harvest** | Provision / Deployment | The active execution or historical run of a Vine configuration. You *Harvest* a Vine. |
| **Tendril** | Remote Agent | The Go binary running inside the provisioned Kubernetes cluster, polling Trellis and streaming logs. |
| **Vintner** | Documentation | The knowledge base and guides. |

---

## 3. Component Breakdown & Interaction

### 3.1 Grape CLI
*   **Role:** The developer interface used to manage the system.
*   **Features:**
    *   **Login (`grape login`):** Authenticates with Trellis via device flow.
    *   **Bootstrap (`grape bootstrap`):** Deploys a base EKS cluster and installs the Tendril agent via CloudFormation. (Local AWS credentials used; no credentials stored in Trellis).
    *   **Harvest (`grape harvest`):** Triggers a Harvest on a specific Vine configuration.

### 3.2 Trellis (Web Control Plane)
*   **Role:** Central dashboard and state store.
*   **Features:**
    *   Manages **Vineyards** and **Vines**.
    *   Stores the status of **Harvests**.
    *   Provides real-time UI for viewing Tendril logs during a Harvest.
    *   Features an interactive **Estate Map** (React Flow topology grid).

### 3.3 Tendril (Remote Agent)
*   **Role:** The in-cluster execution engine.
*   **Features:**
    *   Installed during `grape bootstrap`.
    *   Polls Trellis for pending Harvests.
    *   Executes infrastructure changes based on the Vine config.
    *   Streams logs back to Trellis.

---

## 4. The React Flow Vision (The "Estate Map")

Instead of a standard list of configurations and deployments inside a Vineyard, Trellis uses **React Flow** to create an interactive topology grid—an "Estate Map".

- **Vineyard (Workspace):** The overarching canvas workspace.
- **Vines (Configurations):** The foundational nodes on the canvas representing the declarative state of the infrastructure (AWS VPCs, EKS Clusters, Databases).
- **Harvests (Deployments):** The execution nodes that stem from a Vine. When a Vine is provisioned, it yields a Harvest (an active deployment state or historical run).
- **Tendrils (Agents):** Live connection nodes representing the actual Kubernetes clusters reporting back to Trellis.

This visual approach allows users to literally see the flow of their infrastructure: from a raw Vine -> to an active Harvest -> running on a live Tendril.

---

## 5. Current State: What is Done vs. Left to Do

### What is Done (Implemented / Conceptualized)
*   **Architecture Shift:** The conceptual move to the zero-credential Control Plane and pull-based Tendril Agent is established.
*   **CLI Foundations:** `grape login` and device flow authentication.
*   **Configuration State:** Database schemas for Vineyards, Vines (`configurations`), and Harvests (`provisions`) within Trellis (Supabase).
*   **Infrastructure Templates:** Base Terraform/Helm templates for standard AWS/EKS deployments are available.
*   **Estate Map Foundation:** Basic React Flow canvas rendering Vine nodes.

### What is Left to Do (Pending Implementation)
*   **`grape bootstrap` Execution:**
    *   Implement the AWS CloudFormation generation and execution within the Grape CLI to spin up the base EKS cluster and install Tendril without local Terraform dependencies.
*   **Tendril Agent Implementation:**
    *   Finalize the Go-based agent logic for secure polling, securely retrieving Vine configs, and executing Terraform/Helm commands from within the cluster.
    *   Implement robust log streaming from Tendril to Trellis (Supabase Realtime).
*   **Trellis UI Refinement:**
    *   Build the real-time Harvest observation dashboard using the logs pushed by Tendril.
*   **E2E Workflow Validation:**
    *   End-to-end testing of `grape bootstrap` -> `grape harvest` -> UI Log Streaming.