// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Package build renders the in-cluster image-build machinery for W2. A repo-sourced service
// (Source.Kind=="repo") is built by a kaniko Job that runs IN the customer's own provisioned
// cluster and pushes to their ECR via a build ServiceAccount's IRSA — the customer's compute,
// zero platform keys held for the build (the "own-it + keyless" shape). This package is the pure
// renderer; scheduling/watching the Job and capturing the pushed digest is the runner handler
// (#588); enqueuing BUILD and persisting resolved_image is the console (#590).
package build

import (
	"fmt"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// kanikoImage is the PINNED kaniko executor. Never `:latest` — retiring `<name>:latest` is exactly
// what W2 exists to do, so the builder that does it must not float its own tag.
const kanikoImage = "gcr.io/kaniko-project/executor:v1.23.2"

// digestFilePath is where kaniko writes the pushed image's name+digest. The BUILD runner handler
// (#588) reads it to capture the resolved digest URI written back to the service's resolved_image.
const digestFilePath = "/workspace/image-digest"

// buildTTLSeconds auto-deletes a finished build Job so builds don't accumulate in the cluster.
const buildTTLSeconds int32 = 3600

// KanikoBuildParams are the inputs to RenderKanikoJob.
//
// A params struct (rather than positional args) because the renderer genuinely needs the target
// Namespace and the GitSHA — the destination tag is derived from the exact built commit, and the
// caller (#588/#590) has both — and a struct stays extensible as W2 grows (cache flags, resource
// limits). Service MUST be a repo-sourced workload (Source.Kind=="repo"); image-sourced services
// are used directly and never built.
type KanikoBuildParams struct {
	Service             types.ProjectServiceConfig
	Namespace           string // where the build Job runs
	ECRDestURL          string // <acct>.dkr.ecr.<region>.amazonaws.com/<repo>
	BuildServiceAccount string // the SA whose IRSA grants ECR push
	GitContext          string // kaniko --context: the git URL pinned to the built commit
	GitSHA              string // the built commit — the immutable destination tag
}

// RenderKanikoJob renders the in-cluster kaniko build Job for one repo-sourced service: it builds
// the service's Dockerfile from GitContext and pushes to <ECRDestURL>:<GitSHA> under
// BuildServiceAccount (IRSA → ECR), writing the pushed digest to a file the runner captures. The
// image is tagged with the immutable git SHA. Pure: no I/O, deterministic for a given input.
func RenderKanikoJob(p KanikoBuildParams) *batchv1.Job {
	dockerfile := "Dockerfile"
	if p.Service.Build != nil && p.Service.Build.Dockerfile != "" {
		dockerfile = p.Service.Build.Dockerfile
	}

	args := []string{
		"--context=" + p.GitContext,
		"--dockerfile=" + dockerfile,
	}
	// The build context sub-path (a monorepo service directory) is optional — omit it for a
	// root-context build so the rendered args stay minimal.
	if p.Service.Build != nil && p.Service.Build.Context != "" {
		args = append(args, "--context-sub-path="+p.Service.Build.Context)
	}
	args = append(args,
		"--destination="+p.ECRDestURL+":"+p.GitSHA,
		"--image-name-with-digest-file="+digestFilePath,
	)

	labels := map[string]string{
		"app.kubernetes.io/managed-by": "alethia",
		"alethia.io/service":           p.Service.Name,
		"alethia.io/build-sha":         p.GitSHA,
	}

	backoffLimit := int32(0) // a failed build is a real failure — never silently retry.
	ttl := buildTTLSeconds

	return &batchv1.Job{
		TypeMeta: metav1.TypeMeta{APIVersion: "batch/v1", Kind: "Job"},
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s-build-%s", p.Service.Name, shortSHA(p.GitSHA)),
			Namespace: p.Namespace,
			Labels:    labels,
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:            &backoffLimit,
			TTLSecondsAfterFinished: &ttl,
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: labels},
				Spec: corev1.PodSpec{
					ServiceAccountName: p.BuildServiceAccount,
					RestartPolicy:      corev1.RestartPolicyNever,
					Containers: []corev1.Container{{
						Name:  "kaniko",
						Image: kanikoImage,
						Args:  args,
					}},
				},
			},
		},
	}
}

// shortSHA returns the first 12 chars of a git SHA (for a stable, readable Job name), or the whole
// value when shorter. The caller supplies a DNS-1123-safe Service.Name (validated upstream).
func shortSHA(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}
