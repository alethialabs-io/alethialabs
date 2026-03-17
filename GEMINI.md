# Documentation Standards: ADP ItGix Platform

## 1. Citation Strategy
The thesis documentation for the ADP ItGix project relies heavily on established technical literature and official cloud provider documentation. Due to the precise nature of technical definitions, many sections utilize direct quotes and summarized academic/technical concepts.

### Quotes and References File
All external sources are to be tracked in a separate `references.md` file under the heading **ИЗПОЛЗВАНА ЛИТЕРАТУРА**. 
* **Format:** `[index] Title/Context – URL`
* **Usage:** When a definition is used in the text, the corresponding index is placed at the end of the sentence.
    * *Example:* "Понятието DevOps е комбинация от термините 'development' и 'operations'... [1][2]"

---

## 2. Table of Contents (Съдържание)
To ensure academic rigor, the documentation must include a structured content tree. For the Next.js portal, this should be generated dynamically or mapped as follows:
* **Introduction:** Project scope and objectives.
* **Architecture:** The bridge between Next.js, Python, and Terraform.
* **Auth Integration:** Security protocols for AWS configuration.
* **Implementation:** Component-by-component breakdown.

---

## 3. Glossary of Terms (Терминологичен речник)
Technical terms must be shortened after their first introduction. The file `glossary.md` acts as the source of truth for these abbreviations.

| Abbreviation | Full Term |
| :--- | :--- |
| API | Application Programming Interface |
| AWS | Amazon Web Services |
| AZ | Availability Zone |
| CD | Continuous Delivery / Deployment |
| CI | Continuous Integration |
| IaC | Infrastructure as Code |
| SPA | Single Page Application |

**Rule:** Once a term is defined in the glossary, the abbreviation should be used consistently throughout the technical documentation to maintain brevity.

---

## 4. Coding Standards & Preferences

### Frontend (React/Next.js)
*   **State Management:** Avoid `useState` for form handling. Use `react-hook-form` for all form interactions to ensure performance and scalability.
*   **Validation:** Use `zod` schema validation for all user inputs and forms. Do not rely on simple string matching.
*   **Styling:** Use Tailwind CSS with ShadCN UI components.

---

## 5. Agent Workflow Rules
*   **Feature Planning:** Always save progress for each feature in an `.md` file inside `spec/features/` with checkable task lists.
*   **Code Proposal:** NEVER start proposing code without giving the full rundown of the plan beforehand and explicitly asking for approval.