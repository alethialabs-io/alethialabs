// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package provisioner

import "testing"

// #6736: a probe says "gone" only when the failure positively shows the cluster no longer exists.
// Anything else — a timeout, a refused dial, a resolver failure on a name the cloud does not own —
// stays "unreachable", because the probe cannot tell those apart from a network problem.
func TestClusterGone(t *testing.T) {
	cases := []struct {
		name, reason, endpoint string
		want                   bool
	}{
		{"azure resource group deleted", "ERROR: (ResourceGroupNotFound) Resource group 'rg-a640-development' could not be found.", "", true},
		{"aws cluster deleted", "An error occurred (ResourceNotFoundException) when calling the DescribeCluster operation: No cluster found for name: web.", "", true},
		{"aks hostname no longer resolves", "dial tcp: lookup a640-dns-1234.hcp.westeurope.azmk8s.io: no such host", "https://a640-dns-1234.hcp.westeurope.azmk8s.io:443", true},
		{"eks hostname no longer resolves", "dial tcp: lookup ABCD.gr7.eu-west-1.eks.amazonaws.com: no such host", "https://ABCD.gr7.eu-west-1.eks.amazonaws.com", true},
		{"a customer-managed name that does not resolve is not proof", "dial tcp: lookup k8s.example.com: no such host", "https://k8s.example.com:6443", false},
		{"an IP endpoint timing out is unreachable", "dial tcp 34.1.2.3:443: i/o timeout", "https://34.1.2.3", false},
		{"a refused dial is unreachable", "dial tcp 10.0.0.1:6443: connect: connection refused", "10.0.0.1:6443", false},
		{"a generic not found is not proof", "the server could not find the requested resource (NotFound)", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := clusterGone(c.reason, c.endpoint); got != c.want {
				t.Fatalf("clusterGone(%q, %q) = %v, want %v", c.reason, c.endpoint, got, c.want)
			}
		})
	}
}
