// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package k8s drives a Kubernetes cluster: kubeconfig resolution against a live EKS API, manifest
// apply, readiness probing and namespace post-mortems. It also re-exports the pure manifest decoder
// that used to live here, which now sits in the k8s/manifest LEAF.
//
// The split is the point of #2342. This package constructs an EKS client, and Go has no sub-package
// import granularity, so anything importing it inherits the AWS SDK's whole dependency closure. The
// only symbol `packages/core/verify` ever wanted was the YAML decoder — and `verify` is imported by
// the Homebrew-distributed `alethia` CLI, which was therefore carrying the AWS SDK for a YAML parser.
package k8s

import "github.com/alethialabs-io/alethialabs/packages/core/k8s/manifest"

// Resource is one decoded Kubernetes manifest reduced to its identity + raw body.
//
// A type ALIAS, not a definition: k8s.Resource and manifest.Resource must stay the SAME type, so the
// runner (agent.chart_scan), the provisioner and test/e2e keep compiling unchanged and can pass
// values across the seam in either direction. A defined type here would silently split them.
type Resource = manifest.Resource

// Decode decodes a (possibly multi-document) YAML manifest stream into resources. See
// manifest.Decode — this is the compatibility re-export for the callers that predate the split.
//
// A var rather than a wrapper func so it stays a single reference to one implementation; there is
// exactly one decoder, which is the invariant the original package doc named.
var Decode = manifest.Decode

// AsString coerces a decoded YAML scalar to a string. See manifest.AsString — re-exported so
// workloads.go and the decoder share one coercion across the leaf boundary.
var asString = manifest.AsString
