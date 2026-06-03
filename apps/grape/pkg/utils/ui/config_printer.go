package ui

import (
	"fmt"
	"strings"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
	"github.com/charmbracelet/lipgloss"
)

var (
	subHeaderStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color(ColorMuted)).Padding(0, 0, 0, 2)
	printKeyStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color(ColorKey)).Padding(0, 2, 0, 4)
)

func PrintConfiguration(config types.Configuration) {
	doc := strings.Builder{}

	kv := func(key string, value string) string {
		return printKeyStyle.Render(key) + ValueStyle.Render(value)
	}
	kvBool := func(key string, value *bool) string {
		valStr := "Disabled"
		if value != nil && *value {
			valStr = "Enabled"
		}
		return kv(key, valStr)
	}
	kvNum := func(key string, value *float64) string {
		valStr := "N/A"
		if value != nil {
			if *value == float64(int(*value)) {
				valStr = fmt.Sprintf("%d", int(*value))
			} else {
				valStr = fmt.Sprintf("%.1f", *value)
			}
		}
		return kv(key, valStr)
	}
	kvTime := func(key string, value time.Time) string {
		if value.IsZero() {
			return kv(key, "N/A")
		}
		return kv(key, value.Format("2006-01-02 15:04:05"))
	}

	doc.WriteString(AccentStyle.Render("  Configuration Details"))
	doc.WriteString("\n\n")
	doc.WriteString(kv("Project:", config.ProjectName))
	doc.WriteString("\n")
	doc.WriteString(kv("Environment:", config.EnvironmentStage))
	doc.WriteString("\n")
	doc.WriteString(kv("Container Platform:", config.ContainerPlatform))
	doc.WriteString("\n")
	if !config.UpdatedAt.IsZero() {
		doc.WriteString(kvTime("Last Updated:", config.UpdatedAt))
		doc.WriteString("\n\n")
	} else {
		doc.WriteString("\n")
	}

	doc.WriteString(subHeaderStyle.Render("AWS Configuration"))
	doc.WriteString("\n")
	doc.WriteString(kv("Account ID:", config.AwsAccountID))
	doc.WriteString("\n")
	doc.WriteString(kv("Region:", config.AwsRegion))
	doc.WriteString("\n\n")

	doc.WriteString(subHeaderStyle.Render("Network Configuration"))
	doc.WriteString("\n")
	doc.WriteString(kvBool("Create VPC:", config.CreateVpc))
	if config.CreateVpc != nil && *config.CreateVpc {
		doc.WriteString("\n")
		doc.WriteString(kv("VPC CIDR:", derefString(config.VpcCidr)))
	}
	doc.WriteString("\n")
	doc.WriteString(kvBool("Enable DNS:", config.EnableDns))
	if config.EnableDns != nil && *config.EnableDns {
		doc.WriteString("\n")
		doc.WriteString(kv("Hosted Zone:", derefString(config.DnsHostedZone)))
		doc.WriteString("\n")
		doc.WriteString(kv("Domain Name:", derefString(config.DnsDomainName)))
	}
	doc.WriteString("\n\n")

	doc.WriteString(subHeaderStyle.Render("Database Configuration"))
	doc.WriteString("\n")
	doc.WriteString(kvNum("Min Capacity:", config.DbMinCapacity))
	doc.WriteString("\n")
	doc.WriteString(kvNum("Max Capacity:", config.DbMaxCapacity))
	doc.WriteString("\n\n")

	doc.WriteString(subHeaderStyle.Render("Security"))
	doc.WriteString("\n")
	doc.WriteString(kvBool("CloudFront WAF:", config.EnableCloudfrontWaf))
	doc.WriteString("\n")
	doc.WriteString(kvBool("Redis:", config.EnableRedis))
	if config.EnableRedis != nil && *config.EnableRedis {
		doc.WriteString("\n")
		doc.WriteString(kv("Allowed CIDR Blocks:", derefString(config.RedisAllowedCidrBlocks)))
	}
	doc.WriteString("\n\n")

	doc.WriteString(subHeaderStyle.Render("Advanced"))
	doc.WriteString("\n")
	doc.WriteString(kvBool("Karpenter Auto-Scaling:", config.EnableKarpenter))
	doc.WriteString("\n")
	doc.WriteString(kv("Terraform Version:", config.TerraformVersion))
	doc.WriteString("\n")

	fmt.Println(doc.String())
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
