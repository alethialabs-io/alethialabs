package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/types"
	"github.com/go-playground/validator/v10"
	"gopkg.in/yaml.v3"
)

var validate *validator.Validate

func init() {
	validate = validator.New(validator.WithRequiredStructEnabled())
}

func LoadInstallerConfig(filePath string) (*types.InstallerConfig, error) {
	if filePath == "" {
		return nil, fmt.Errorf("config file path cannot be empty")
	}

	buf, err := os.ReadFile(filePath)
	if err != nil {
		return nil, fmt.Errorf("error reading config file: %w", err)
	}

	var config types.InstallerConfig
	err = yaml.Unmarshal(buf, &config)
	if err != nil {
		return nil, fmt.Errorf("error parsing config file: %w", err)
	}

	var rawConfig map[string]interface{}
	if err := yaml.Unmarshal(buf, &rawConfig); err != nil {
		return nil, fmt.Errorf("error parsing raw config file: %w", err)
	}
	config.Raw = rawConfig

	return &config, nil
}

func ValidateInstallerConfig(cfg *types.InstallerConfig) error {
	if cfg == nil {
		return fmt.Errorf("config cannot be nil")
	}

	if err := validate.Struct(cfg); err != nil {
		validationErrors, ok := err.(validator.ValidationErrors)
		if !ok {
			return fmt.Errorf("validation failed: %w", err)
		}
		var msgs []string
		for _, fe := range validationErrors {
			msgs = append(msgs, fmt.Sprintf("  - %s: failed on '%s' (value: '%v')", fe.Field(), fe.Tag(), fe.Value()))
		}
		return fmt.Errorf("config validation errors:\n%s", strings.Join(msgs, "\n"))
	}

	maxNameLen := 15
	maxEnvLen := 5
	maxCombinedLen := 10
	if cfg.AllowLongNames != nil && *cfg.AllowLongNames {
		maxNameLen = 25
		maxEnvLen = 15
		maxCombinedLen = 30
	}

	if len(cfg.ProjectName) > maxNameLen {
		return fmt.Errorf("project_name '%s' exceeds max length %d (set allow_long_names: true for extended limits)", cfg.ProjectName, maxNameLen)
	}
	if len(cfg.Environment) > maxEnvLen {
		return fmt.Errorf("environment '%s' exceeds max length %d (set allow_long_names: true for extended limits)", cfg.Environment, maxEnvLen)
	}
	if len(cfg.ProjectName)+len(cfg.Environment) > maxCombinedLen {
		return fmt.Errorf("combined project_name + environment length %d exceeds max %d", len(cfg.ProjectName)+len(cfg.Environment), maxCombinedLen)
	}

	normalizeGitSuffix(&cfg.GitopsDestinationRepo)
	normalizeGitSuffix(&cfg.ApplicationsDestinationRepo)
	normalizeGitSuffix(&cfg.EnvGitRepo)

	return nil
}

func normalizeGitSuffix(repoURL *string) {
	if *repoURL != "" && !strings.HasSuffix(*repoURL, ".git") {
		*repoURL += ".git"
	}
}

func InstallerConfigToConfiguration(installer *types.InstallerConfig) (*types.Configuration, error) {
	if installer == nil {
		return nil, fmt.Errorf("installer config cannot be nil")
	}

	if err := ValidateInstallerConfig(installer); err != nil {
		return nil, err
	}

	config := &types.Configuration{
		AwsAccountID:                   installer.AwsAccountID,
		AwsRegion:                      installer.Region,
		EnvironmentStage:               installer.Environment,
		ProjectName:                    installer.ProjectName,
		TerraformVersion:               installer.TerraformVer,
		EnvTemplateRepo:                installer.EnvTemplateRepo,
		EnvTemplateRepoBranch:          installer.EnvTemplateRepoBranch,
		EnvGitRepo:                     installer.EnvGitRepo,
		GitopsTemplateRepo:             installer.GitopsTemplateRepo,
		GitopsTemplateRepoBranch:       installer.GitopsTemplateRepoBranch,
		GitopsDestinationRepo:          installer.GitopsDestinationRepo,
		ApplicationsTemplateRepo:       installer.ApplicationsTemplateRepo,
		ApplicationsTemplateRepoBranch: installer.ApplicationsTemplateRepoBranch,
		ApplicationsDestinationRepo:    installer.ApplicationsDestinationRepo,
		CreateVpc:                      installer.ProvisionVPC,
		VpcCidr:                        stringPtrIfSet(installer.VPCCIDR),
		EnableDns:                      installer.ACMCertificateEnable,
		DnsHostedZone:                  stringPtrIfSet(installer.DNSHostedZone),
		DnsDomainName:                  stringPtrIfSet(installer.DNSMainDomain),
		EnableRedis:                    installer.CreateElasticacheRedis,
		EnableKarpenter:                installer.EnableKarpenter,
		EnableCloudfrontWaf:            installer.CloudfrontWAFEnabled,
	}

	if installer.GitopsArgoAccessToken != "" {
		config.GitopsArgocdToken = &installer.GitopsArgoAccessToken
	}
	if installer.ApplicationsArgoAccessToken != "" {
		config.GitopsAppToken = &installer.ApplicationsArgoAccessToken
	}
	if installer.CreateRDS != nil && *installer.CreateRDS {
		minCapacity := 1.0
		config.DbMinCapacity = &minCapacity
	}
	if len(installer.RedisAllowedCidrBlocks) > 0 {
		redisAllowedCidrBlocks := strings.Join(installer.RedisAllowedCidrBlocks, ",")
		config.RedisAllowedCidrBlocks = &redisAllowedCidrBlocks
	}
	if installer.Raw != nil {
		rawConfig, err := json.Marshal(installer.Raw)
		if err != nil {
			return nil, fmt.Errorf("error encoding raw config: %w", err)
		}
		rawConfigString := string(rawConfig)
		config.FullConfig = &rawConfigString
	}

	return config, nil
}

func stringPtrIfSet(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}
