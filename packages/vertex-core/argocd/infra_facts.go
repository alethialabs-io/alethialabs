// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package argocd

import (
	"github.com/bobikenobi12/bb-thesis-2026/packages/vertex-core/types"
)

type InfraFacts struct {
	ProjectName      string
	Environment      string
	Region           string
	Provider         string
	DomainName       string
	DNSZoneID        string
	EnableKarpenter  bool

	ClusterName              string
	ClusterEndpoint          string
	ClusterArn               string
	AWSAccountID             string
	VPCID                    string
	ACMCertificateArn        string
	IRSAExternalDNSArn       string
	IRSAALBControllerArn     string
	NodeIAMRoleName          string
	NodeSecurityGroup        string
	KarpenterQueueName       string

	AppsDestinationRepo string
}

func BuildFromOutputs(outputs map[string]interface{}, vc *types.VineConfig) *InfraFacts {
	enableKarpenter := false
	if v, ok := vc.Cluster.ProviderConfig["enable_karpenter"]; ok {
		if b, ok := v.(bool); ok {
			enableKarpenter = b
		}
	}

	return &InfraFacts{
		ProjectName:     vc.ProjectName,
		Environment:     vc.EnvironmentStage,
		Region:          vc.Region,
		Provider:        vc.Provider,
		DomainName:      vc.DNS.DomainName,
		DNSZoneID:       vc.DNS.ZoneID,
		EnableKarpenter: enableKarpenter,

		ClusterName:              ExtractOutput(outputs, "eks_cluster_name"),
		ClusterEndpoint:          ExtractOutput(outputs, "eks_cluster_endpoint"),
		ClusterArn:               ExtractOutput(outputs, "eks_cluster_arn"),
		AWSAccountID:             vc.CloudAccountID,
		VPCID:                    ExtractOutput(outputs, "vpc_id"),
		ACMCertificateArn:        ExtractOutput(outputs, "acm_certificate_arn"),
		IRSAExternalDNSArn:       ExtractOutput(outputs, "eks_irsa_external_dns_arn"),
		IRSAALBControllerArn:     ExtractOutput(outputs, "eks_irsa_alb_controller_arn"),
		NodeIAMRoleName:          ExtractOutput(outputs, "node_iam_role_name"),
		NodeSecurityGroup:        ExtractOutput(outputs, "node_security_group"),
		KarpenterQueueName:       ExtractOutput(outputs, "karpenter_queue_name"),

		AppsDestinationRepo: vc.Repositories.AppsDestinationRepo,
	}
}

func ExtractOutput(outputs map[string]interface{}, key string) string {
	val, ok := outputs[key]
	if !ok || val == nil {
		return ""
	}
	if s, ok := val.(string); ok {
		return s
	}
	if m, ok := val.(map[string]interface{}); ok {
		if v, ok := m["value"].(string); ok {
			return v
		}
	}
	return ""
}
