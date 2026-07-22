// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/service/eks"
	ekstypes "github.com/aws/aws-sdk-go-v2/service/eks/types"
)

// ErrClusterNotReady is returned when an EKS cluster exists but its control-plane connection
// details aren't populated yet — it isn't ACTIVE. Callers must treat this as "retry later", never
// by dereferencing the (still-nil) endpoint/CA/ARN fields, which would panic. This is the exact
// state a just-provisioned cluster is in during the window the kubeconfig is first requested.
var ErrClusterNotReady = errors.New("eks cluster is not ACTIVE yet")

// DescribeClusterAPI is the slice of the EKS client used to resolve a cluster's connection
// details — an interface so callers are unit-testable against a fake. *eks.Client satisfies it.
type DescribeClusterAPI interface {
	DescribeCluster(context.Context, *eks.DescribeClusterInput, ...func(*eks.Options)) (*eks.DescribeClusterOutput, error)
}

// EKSClusterConn is the connection detail needed to build a kubeconfig for a ready cluster.
type EKSClusterConn struct {
	ARN      string
	Endpoint string
	// CAData is the base64 certificate-authority data (the kubeconfig `certificate-authority-data`).
	CAData string
	// OIDCIssuer is the cluster's IRSA OpenID-Connect issuer URL (`https://oidc.eks.<region>.amazonaws.com/id/<id>`).
	// Best-effort: populated when the cluster reports one (every EKS cluster does), empty otherwise — it is
	// NOT required to build a kubeconfig, so its absence never makes a cluster "not ready". The per-namespace
	// IRSA path (#957) needs it and errors clearly if it's empty.
	OIDCIssuer string
}

// ResolveEKSClusterConn calls DescribeCluster and safely extracts the cluster's connection
// details. It returns ErrClusterNotReady — never a panic — when the cluster isn't ACTIVE or any
// pointer field the kubeconfig needs is still nil. A describe API error is wrapped and returned.
func ResolveEKSClusterConn(ctx context.Context, api DescribeClusterAPI, clusterName string) (EKSClusterConn, error) {
	resp, err := api.DescribeCluster(ctx, &eks.DescribeClusterInput{Name: &clusterName})
	if err != nil {
		return EKSClusterConn{}, fmt.Errorf("failed to describe cluster: %w", err)
	}
	c := resp.Cluster
	if c == nil ||
		c.Status != ekstypes.ClusterStatusActive ||
		c.Arn == nil ||
		c.Endpoint == nil ||
		c.CertificateAuthority == nil ||
		c.CertificateAuthority.Data == nil {
		return EKSClusterConn{}, fmt.Errorf("%w: %q", ErrClusterNotReady, clusterName)
	}
	conn := EKSClusterConn{
		ARN:      *c.Arn,
		Endpoint: *c.Endpoint,
		CAData:   *c.CertificateAuthority.Data,
	}
	// Best-effort: the OIDC issuer is only needed by the per-namespace IRSA path, not the kubeconfig.
	if c.Identity != nil && c.Identity.Oidc != nil && c.Identity.Oidc.Issuer != nil {
		conn.OIDCIssuer = *c.Identity.Oidc.Issuer
	}
	return conn, nil
}
