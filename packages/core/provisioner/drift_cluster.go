// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/cloud"
	"github.com/alethialabs-io/alethialabs/packages/core/drift"
	"github.com/alethialabs-io/alethialabs/packages/core/types"
	tfjson "github.com/hashicorp/terraform-json"
)

// ClusterEvidenceFunc reads, at drift-scan time, what the cluster says about the cloud changes its
// controllers own (drift.ParseClusterEvidence). outputs are the drift run's workspace outputs, which
// kubeconfig acquisition needs. An error means NO evidence — never "the cluster owns nothing".
type ClusterEvidenceFunc func(ctx context.Context, outputs map[string]interface{}) (*drift.ClusterEvidence, error)

const (
	// clusterEvidenceBudget bounds the whole cluster read — kubeconfig acquisition and both
	// kubectl calls — so an unreachable API server can delay a drift job by at most this much.
	clusterEvidenceBudget = 90 * time.Second
	// clusterEvidenceCallTimeout bounds each kubectl call inside that budget.
	clusterEvidenceCallTimeout = 30 * time.Second
)

// kubectlRead is runKubectlBounded; a variable so tests can stand in for a cluster.
var kubectlRead = runKubectlBounded

// configureClusterKubeconfig points kubectl at the environment's cluster, exactly as
// InspectCluster does; a variable so tests need no cloud.
var configureClusterKubeconfig = func(ctx context.Context, vc *types.ProjectConfig, providerSlug string, outputs map[string]interface{}, stdout io.Writer) error {
	provider, err := cloud.NewCloudProvider(providerSlug)
	if err != nil {
		return err
	}
	return provider.ConfigureKubeconfig(ctx, vc, outputs, stdout)
}

// ClusterEvidenceReader returns the cluster-evidence read for an environment's drift job, or nil
// when there is nothing to read: the only evidence consumer today is the AWS Load Balancer
// Controller rule (drift's kubernetes-owned tier), so only aws gets a reader. A nil reader leaves
// the drift posture exactly as it was.
func ClusterEvidenceReader(vc *types.ProjectConfig, providerSlug string, stdout io.Writer) ClusterEvidenceFunc {
	if providerSlug != "aws" || vc == nil {
		return nil
	}
	return func(ctx context.Context, outputs map[string]interface{}) (*drift.ClusterEvidence, error) {
		return readClusterEvidence(ctx, vc, providerSlug, outputs, stdout)
	}
}

// readClusterEvidence acquires kubeconfig for the environment's cluster and reads its
// TargetGroupBindings and Services, within clusterEvidenceBudget. Every failure — no cluster name,
// kubeconfig, either read, a document that is not a list — is returned as an error, so the caller
// keeps the drift it already has.
func readClusterEvidence(ctx context.Context, vc *types.ProjectConfig, providerSlug string, outputs map[string]interface{}, stdout io.Writer) (*drift.ClusterEvidence, error) {
	ctx, cancel := context.WithTimeout(ctx, clusterEvidenceBudget)
	defer cancel()
	merged := clusterOutputs(vc, providerSlug, outputs)
	name := cloud.ExtractClusterName(merged)
	if name == "" {
		return nil, errors.New("no cluster name")
	}
	if err := configureClusterKubeconfig(ctx, vc, providerSlug, merged, stdout); err != nil {
		return nil, fmt.Errorf("kubeconfig: %w", err)
	}
	tgbs, err := kubectlRead(ctx, clusterEvidenceCallTimeout, "get", "targetgroupbindings.elbv2.k8s.aws", "--all-namespaces", "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("read targetgroupbindings: %w", err)
	}
	svcs, err := kubectlRead(ctx, clusterEvidenceCallTimeout, "get", "services", "--all-namespaces", "-o", "json")
	if err != nil {
		return nil, fmt.Errorf("read services: %w", err)
	}
	return drift.ParseClusterEvidence(name, []byte(tgbs), []byte(svcs))
}

// clusterOutputs is outputs plus, when they carry no cluster name, the configured one under the
// provider's output key — the same fallback InspectCluster uses so aws/gcp/azure work without
// outputs. outputs itself is never modified.
func clusterOutputs(vc *types.ProjectConfig, providerSlug string, outputs map[string]interface{}) map[string]interface{} {
	merged := make(map[string]interface{}, len(outputs)+1)
	for k, v := range outputs {
		merged[k] = v
	}
	if _, ok := merged[clusterNameOutputKey(providerSlug)]; !ok && vc.Cluster.ClusterName != "" {
		merged[clusterNameOutputKey(providerSlug)] = vc.Cluster.ClusterName
	}
	return merged
}

// applyClusterEvidence re-analyzes a still-drifted posture with the cluster's evidence. It is only
// ever a narrowing — drift.AnalyzeWithEvidence can move a resource from drifted to kubernetes-owned,
// never the reverse (drift's TestClusterEvidenceNeverIncreasesDrift) — so it runs only when the
// posture is not already in sync, and on any failure it returns the posture it was given.
//
// Only a COUNT of the evidence is logged: its contents are security-group ids and ports.
func applyClusterEvidence(ctx context.Context, posture *drift.Posture, plan *tfjson.Plan, schemas *tfjson.ProviderSchemas, outputs map[string]interface{}, read ClusterEvidenceFunc, stdout, stderr io.Writer) *drift.Posture {
	if read == nil || posture.InSync {
		return posture
	}
	ev, err := read(ctx, outputs)
	if err != nil || ev == nil {
		fmt.Fprintf(stderr, "Warning: could not read cluster evidence; controller-owned rules stay drift for this run: %v\n", err)
		return posture
	}
	fmt.Fprintf(stdout, "Drift: cluster evidence read (%d live TargetGroupBinding(s) with networking)\n", ev.Bindings())
	return drift.AnalyzeWithEvidence(plan, schemas, ev)
}
