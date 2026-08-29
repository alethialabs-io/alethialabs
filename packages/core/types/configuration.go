// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package types

import "time"

type ConfigurationSummary struct {
	ID                   string           `json:"id"`
	ProjectName          string           `json:"project_name"`
	EnvironmentStage     EnvironmentStage `json:"environment_stage"`
	Status               ProjectStatus    `json:"status"`
	Region               string           `json:"region"`
	CloudProvider        CloudProvider    `json:"cloud_provider"`
	EstimatedMonthlyCost *float64         `json:"estimated_monthly_cost"`
	CreatedAt            time.Time        `json:"created_at"`
	UpdatedAt            time.Time        `json:"updated_at"`
}

type Configuration struct {
	CloudAccountID    string    `json:"cloud_account_id"`
	Region            string    `json:"region"`
	ContainerPlatform string    `json:"container_platform"`
	ProvisionNetwork  *bool     `json:"provision_network"`
	CreatedAt         time.Time `json:"created_at"`
	DbMaxCapacity     *float64  `json:"db_max_capacity"`
	DbMinCapacity     *float64  `json:"db_min_capacity"`
	Description       *string   `json:"description"`
	DnsDomainName     *string   `json:"dns_domain_name"`
	DnsZoneID         *string   `json:"dns_zone_id"`
	DownloadCount     *int      `json:"download_count"`
	// ClusterAdmins is a LIST, and typing it as *string broke every `alethia project get` on a
	// project that has any: the API serialises the project_cluster_admins rows as an array, and the
	// CLI died on
	//
	//	json: cannot unmarshal array into Go struct field Configuration.configuration.cluster_admins of type string
	//
	// It is `[]any` to match ProjectClusterConfig.ClusterAdmins in project_config.go — the sibling
	// struct in this same package, describing the same field, which every real consumer already
	// reads (aws_provider's eks_cluster_admins, azure_provider's admin group ids). Two shapes for
	// one field is what let this sit: nothing in the repo reads THIS one, so nothing caught it, and
	// the only symptom was a demo-path command failing on a decode.
	ClusterAdmins           []any            `json:"cluster_admins"`
	DnsEnabled              *bool            `json:"dns_enabled"`
	EnableGitopsDestination *bool            `json:"enable_gitops_destination"`
	HasCache                *bool            `json:"has_cache"`
	EnvironmentRepository   *string          `json:"environment_repository"`
	EnvironmentStage        EnvironmentStage `json:"environment_stage"`
	FullConfig              *string          `json:"full_config"`
	GitopsAppTemplate       *string          `json:"gitops_app_template"`
	GitopsAppToken          *string          `json:"gitops_app_token"`
	GitopsArgocdToken       *string          `json:"gitops_argocd_token"`
	GitopsDestinationsRepo  *string          `json:"gitops_destinations_repo"`
	GitopsRepository        *string          `json:"gitops_repository"`

	ID               string  `json:"id"`
	LastDownloadedAt *string `json:"last_downloaded_at"`
	// Name                    string    `json:"name"`
	ProjectName            string         `json:"project_name"`
	RedisAllowedCidrBlocks *string        `json:"redis_allowed_cidr_blocks"`
	SesQueuesTopics        *string        `json:"ses_queues_topics"`
	Status                 *ProjectStatus `json:"status"`
	IacVersion             string         `json:"iac_version"`
	UiPositionX            *float64       `json:"ui_position_x"`
	UiPositionY            *float64       `json:"ui_position_y"`
	UpdatedAt              time.Time      `json:"updated_at"`
	UserID                 string         `json:"user_id"`
	CIDRBlock              *string        `json:"cidr_block"`
}

type DeployJob struct {
	ID              string     `json:"id"`
	ClusterID       string     `json:"cluster_id"`
	ConfigurationID string     `json:"configuration_id"`
	Status          string     `json:"status"`
	CreatedAt       time.Time  `json:"created_at"`
	StartedAt       *time.Time `json:"started_at,omitempty"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
	ErrorMessage    *string    `json:"error_message,omitempty"`
}
