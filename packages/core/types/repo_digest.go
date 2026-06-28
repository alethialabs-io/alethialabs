// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

// RepoFile is a captured (truncated) file from a scanned repository.
type RepoFile struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated,omitempty"`
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
}
