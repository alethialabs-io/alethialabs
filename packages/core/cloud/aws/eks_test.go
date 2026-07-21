// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package aws

import (
	"context"
	"errors"
	"testing"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/eks"
	ekstypes "github.com/aws/aws-sdk-go-v2/service/eks/types"
)

type fakeDescribeCluster struct {
	out *eks.DescribeClusterOutput
	err error
}

func (f fakeDescribeCluster) DescribeCluster(context.Context, *eks.DescribeClusterInput, ...func(*eks.Options)) (*eks.DescribeClusterOutput, error) {
	return f.out, f.err
}

func out(c *ekstypes.Cluster) *eks.DescribeClusterOutput {
	return &eks.DescribeClusterOutput{Cluster: c}
}

func TestResolveEKSClusterConn_ActiveReturnsConn(t *testing.T) {
	api := fakeDescribeCluster{out: out(&ekstypes.Cluster{
		Status:               ekstypes.ClusterStatusActive,
		Arn:                  awssdk.String("arn:aws:eks:us-east-1:111:cluster/c"),
		Endpoint:             awssdk.String("https://eks.example"),
		CertificateAuthority: &ekstypes.Certificate{Data: awssdk.String("BASE64CA")},
	})}
	conn, err := ResolveEKSClusterConn(context.Background(), api, "c")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if conn.ARN != "arn:aws:eks:us-east-1:111:cluster/c" || conn.Endpoint != "https://eks.example" || conn.CAData != "BASE64CA" {
		t.Fatalf("conn = %#v", conn)
	}
}

// The core regression for #942: a cluster that isn't fully ACTIVE must yield ErrClusterNotReady,
// never a nil-pointer panic — the old code dereferenced these fields unconditionally.
func TestResolveEKSClusterConn_NotReadyNeverPanics(t *testing.T) {
	cases := map[string]*ekstypes.Cluster{
		"creating, all fields nil": {Status: ekstypes.ClusterStatusCreating},
		"active but nil endpoint": {
			Status:               ekstypes.ClusterStatusActive,
			Arn:                  awssdk.String("a"),
			CertificateAuthority: &ekstypes.Certificate{Data: awssdk.String("ca")},
		},
		"active but nil CA data": {
			Status:               ekstypes.ClusterStatusActive,
			Arn:                  awssdk.String("a"),
			Endpoint:             awssdk.String("e"),
			CertificateAuthority: &ekstypes.Certificate{},
		},
		"active but nil CA object": {
			Status:   ekstypes.ClusterStatusActive,
			Arn:      awssdk.String("a"),
			Endpoint: awssdk.String("e"),
		},
		"failed": {Status: ekstypes.ClusterStatusFailed, Arn: awssdk.String("a")},
	}
	for name, cluster := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ResolveEKSClusterConn(context.Background(), fakeDescribeCluster{out: out(cluster)}, "c")
			if !errors.Is(err, ErrClusterNotReady) {
				t.Fatalf("err = %v, want ErrClusterNotReady", err)
			}
		})
	}

	// A nil Cluster in the response is also handled without a panic.
	if _, err := ResolveEKSClusterConn(context.Background(), fakeDescribeCluster{out: out(nil)}, "c"); !errors.Is(err, ErrClusterNotReady) {
		t.Fatalf("nil cluster: err = %v, want ErrClusterNotReady", err)
	}
}

func TestResolveEKSClusterConn_DescribeErrorPropagates(t *testing.T) {
	_, err := ResolveEKSClusterConn(context.Background(), fakeDescribeCluster{err: errors.New("boom")}, "c")
	if err == nil || errors.Is(err, ErrClusterNotReady) {
		t.Fatalf("err = %v, want a wrapped describe error (not ErrClusterNotReady)", err)
	}
}
