// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package compat is the version-compatibility matrix + preflight engine (the
// `wave:compat` seam). It maps the platform's independently-versioned parts —
// cluster Kubernetes, platform components (ArgoCD / Talos / Cilium / hcloud CCM
// + CSI), and the add-on charts — to the compatibility constraints that today
// live only as scattered code comments, and evaluates a proposed config against
// them into a structured, honest Report.
//
// The single source of truth is matrix.json, embedded here for the Go engine and
// code-generated into TypeScript (apps/console/scripts/gen-matrix.mjs) for the
// console, so the two never drift — the same discipline the catalog uses. The
// Report contract deliberately mirrors packages/core/verify verbatim (pass / fail
// / warn / not_evaluable, Override, Unwaived): a version the matrix has no data
// for is reported not_evaluable, NEVER a silent pass — the same false-PASS the
// verification headline must never produce.
//
// This is the interface-first seam of epic #1186: it defines the loader, the
// types, and the pure engine, and seeds matrix.json with the known couplings.
// Downstream units enrich the data (add-on K8s ranges), wire the config-time
// warning gate, and wire the fail-closed apply gate (COMPAT-001).
package compat

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"
)

//go:embed matrix.json
var matrixJSON []byte

// Matrix is the parsed compatibility matrix document.
type Matrix struct {
	Version        int                 `json:"version"`
	CatalogVersion string              `json:"catalog_version"`
	K8sCloud       map[string]CloudK8s `json:"k8s_cloud"`
	Components     []Component         `json:"components"`
	AddOnK8s       map[string]K8sRange `json:"addon_k8s"`
	// StaticCouplings are build-time version couplings (e.g. a Go const that must
	// match a Dockerfile ARG). They are carried as data — the SSOT a CI guard
	// asserts against — but have no per-config subject, so the runtime engine does
	// not emit controls for them.
	StaticCouplings []StaticCoupling `json:"static_couplings"`
}

// CloudK8s is a managed cloud's supported Kubernetes minors (mirrors the catalog
// SSOT, which stays authoritative in packages/core/catalog/catalog.json).
type CloudK8s struct {
	Supported []string `json:"supported"`
	Default   string   `json:"default"`
}

// Component is a platform component with its recorded releases.
type Component struct {
	ID       string             `json:"id"`
	Title    string             `json:"title"`
	Releases []ComponentRelease `json:"versions"`
}

// ComponentRelease pins one released version of a component to the Kubernetes
// minor window it supports. An empty bound means unbounded on that side; both
// bounds empty means no window is recorded yet (→ not_evaluable, never a pass).
type ComponentRelease struct {
	Version    string `json:"version"`
	AppVersion string `json:"app_version,omitempty"`
	K8sMin     string `json:"k8s_min"`
	K8sMax     string `json:"k8s_max"`
	Note       string `json:"note,omitempty"`
}

// K8sRange is a supported Kubernetes minor window [K8sMin, K8sMax]. Empty bounds
// follow the same convention as ComponentRelease.
type K8sRange struct {
	K8sMin string `json:"k8s_min"`
	K8sMax string `json:"k8s_max"`
	Note   string `json:"note,omitempty"`
}

// StaticCoupling records a build-time version that must match its peers (a Go
// const, a Dockerfile ARG, and any CI workflow that must run the same engine).
// Data only; asserted by a CI guard, not the runtime engine.
type StaticCoupling struct {
	ID            string `json:"id"`
	Title         string `json:"title,omitempty"`
	Value         string `json:"value"`
	GoConst       string `json:"go_const,omitempty"`
	DockerfileArg string `json:"dockerfile_arg,omitempty"`
	Dockerfile    string `json:"dockerfile,omitempty"`
	// Workflows are CI workflows whose top-level `env` carries another copy of
	// Value. A workflow that gates an artifact on a version DIFFERENT from the one
	// the product ships proves nothing about it, and nothing used to say so: the
	// project-template gate ran OpenTofu 1.10.10 against a runner applying 1.9.0
	// for the life of those templates (#1931). Listing it here brings it under the
	// same drift test as the Go const and the Dockerfile ARG.
	Workflows []CouplingWorkflow `json:"workflows,omitempty"`
	// WorkflowExclusions are the narrow, deliberate places a listed workflow runs
	// something OTHER than Value, carried as data so an exclusion is explicit and
	// drift-checked rather than a silent second literal in a YAML file.
	WorkflowExclusions []CouplingWorkflowExclusion `json:"workflow_exclusions,omitempty"`
	Note               string                      `json:"note,omitempty"`
}

// CouplingWorkflow names a CI workflow and the top-level `env` key in it that must
// carry the coupling's value.
type CouplingWorkflow struct {
	Path   string `json:"path"`
	EnvKey string `json:"env_key"`
	Note   string `json:"note,omitempty"`
}

// CouplingWorkflowExclusion records one documented departure from a coupling
// inside a workflow — what runs a different version, which env key holds it, why
// it has to, the upstream reference, and what retires it. The cloud-parity rule
// admits an exclusion; it does not admit a silent one.
type CouplingWorkflowExclusion struct {
	ID           string `json:"id"`
	Workflow     string `json:"workflow"`
	EnvKey       string `json:"env_key"`
	Value        string `json:"value"`
	Scope        string `json:"scope,omitempty"`
	Reason       string `json:"reason,omitempty"`
	Upstream     string `json:"upstream,omitempty"`
	UpstreamFix  string `json:"upstream_fix,omitempty"`
	WhyThisValue string `json:"why_this_value,omitempty"`
	RetireWhen   string `json:"retire_when,omitempty"`
	Issue        int    `json:"issue,omitempty"`
}

var (
	loaded  *Matrix
	loadErr error
	once    sync.Once
)

// Load parses and memoizes the embedded matrix.
func Load() (*Matrix, error) {
	once.Do(func() {
		var m Matrix
		if err := json.Unmarshal(matrixJSON, &m); err != nil {
			loadErr = fmt.Errorf("compat: parse embedded matrix.json: %w", err)
			return
		}
		loaded = &m
	})
	return loaded, loadErr
}

// MustLoad returns the matrix or panics — the JSON is embedded and validated by a
// test, so a parse failure is a build-time defect, not a runtime condition.
func MustLoad() *Matrix {
	m, err := Load()
	if err != nil {
		panic(err)
	}
	return m
}

// Cloud returns a managed cloud's supported-Kubernetes record.
func (m *Matrix) Cloud(slug string) (CloudK8s, bool) {
	c, ok := m.K8sCloud[slug]
	return c, ok
}

// Release returns a component's recorded release by version.
func (m *Matrix) Release(componentID, version string) (ComponentRelease, bool) {
	for _, c := range m.Components {
		if c.ID != componentID {
			continue
		}
		for _, r := range c.Releases {
			if r.Version == version {
				return r, true
			}
		}
	}
	return ComponentRelease{}, false
}

// AddOnRange returns an add-on's recorded Kubernetes window.
func (m *Matrix) AddOnRange(addonID string) (K8sRange, bool) {
	r, ok := m.AddOnK8s[addonID]
	return r, ok
}
