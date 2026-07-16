// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

// RepoFile is a captured (truncated) file from a scanned repository.
type RepoFile struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated,omitempty"`
}

// DetectedService is one deployable service found inside a repo (monorepo-aware): a
// directory carrying a Dockerfile and/or a language manifest. A single-service repo
// yields one at path "" (root); a monorepo yields several. Mirrors the console's
// DetectedService JSONB shape (types/jsonb.types.ts).
type DetectedService struct {
	// Path within the repo, relative; "" = repo root.
	Path string `json:"path"`
	// Service name, derived from the directory (or the repo for root).
	Name string `json:"name"`
	// Whether a Dockerfile exists at this service's path.
	HasDockerfile bool `json:"hasDockerfile"`
	// Inferred runtime (node/python/go/…), when a manifest reveals it.
	Runtime string `json:"runtime,omitempty"`
	// Container port parsed from the Dockerfile's EXPOSE, when present.
	Port int `json:"port,omitempty"`
	// Needs are the normalized backing-service signals detected in THIS service's own
	// files (per-service attribution of the repo-wide Signals) — the Path-B seed the
	// console maps to SUGGESTED ServiceBindings (W3) for the user to accept/edit.
	Needs []string `json:"needs,omitempty"`
}

// RepoDigest is the deterministic, STATIC analysis of a repository produced by an
// ANALYZE_REPO job (clone + walk + parse — NO repo code is executed). The console
// feeds it to the model to infer the infrastructure a Project should provision. It is
// stored on jobs.execution_metadata.repo_digest.
type RepoDigest struct {
	RepoURL      string         `json:"repo_url"`
	Ref          string         `json:"ref,omitempty"`
	ScannedAt    string         `json:"scanned_at"`
	FileCount    int            `json:"file_count"`
	Truncated    bool           `json:"truncated,omitempty"`
	Languages    map[string]int `json:"languages,omitempty"`
	Manifests    []RepoFile     `json:"manifests,omitempty"`
	Dockerfiles  []RepoFile     `json:"dockerfiles,omitempty"`
	Compose      []RepoFile     `json:"compose,omitempty"`
	K8sManifests []RepoFile     `json:"k8s_manifests,omitempty"`
	CIConfigs    []RepoFile     `json:"ci_configs,omitempty"`
	EnvExamples  []RepoFile     `json:"env_examples,omitempty"`
	Signals      []string       `json:"signals,omitempty"`
	// Deployable services detected in the repo (monorepo-aware). One entry for a
	// single-service repo (path ""); several for a workspace/monorepo.
	Services []DetectedService `json:"services,omitempty"`
}
