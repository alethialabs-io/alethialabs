package argocd

import (
	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
)

type InfraFacts struct {
	ProjectName      string
	Environment      string
	Region           string
	Provider         string
	DomainName       string
	DNSZoneID        string
	EnableKarpenter  bool

	ClusterName        string
	ClusterEndpoint    string
	ClusterArn         string
	AWSAccountID       string
	VPCID              string
	IRSAExternalDNSArn string
	NodeIAMRoleName    string
	NodeSecurityGroup  string
	KarpenterQueueName string
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

		ClusterName:        extractOutput(outputs, "eks_cluster_name"),
		ClusterEndpoint:    extractOutput(outputs, "eks_cluster_endpoint"),
		ClusterArn:         extractOutput(outputs, "eks_cluster_arn"),
		AWSAccountID:       vc.CloudAccountID,
		VPCID:              extractOutput(outputs, "vpc_id"),
		IRSAExternalDNSArn: extractOutput(outputs, "eks_irsa_external_dns_arn"),
		NodeIAMRoleName:    extractOutput(outputs, "node_iam_role_name"),
		NodeSecurityGroup:  extractOutput(outputs, "node_security_group"),
		KarpenterQueueName: extractOutput(outputs, "karpenter_queue_name"),
	}
}

func extractOutput(outputs map[string]interface{}, key string) string {
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
