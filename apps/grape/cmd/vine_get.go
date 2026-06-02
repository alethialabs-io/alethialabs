package cmd

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/bobikenobi12/bb-thesis-2026/packages/grape-core/types"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/imroc/req/v3"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

var openVineInBrowser bool

var vineGetCmd = &cobra.Command{
	Use:   "get [project_name]",
	Short: "Get a specific vine by project name",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		projectName := args[0]

		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}

		webOrigin := getWebOrigin()
		getURL := fmt.Sprintf("%s/api/cli/configurations/by-project-name/%s", webOrigin, projectName)

		client := req.C()
		var result struct {
			Configuration types.Configuration `json:"configuration"`
		}
		var errMsg struct {
			Error string `json:"error"`
		}

		resp, err := client.R().
			SetBearerAuthToken(token).
			SetSuccessResult(&result).
			SetErrorResult(&errMsg).
			Get(getURL)

		if err != nil {
			fmt.Printf("Error connecting to server: %v\n", err)
			os.Exit(1)
		}

		if resp.IsErrorState() {
			fmt.Printf("Error fetching vine (HTTP %d): %s\n", resp.StatusCode, errMsg.Error)
			os.Exit(1)
		}

		if result.Configuration.ID == "" {
			fmt.Printf("No vine found for project: %s\n", projectName)
			return
		}

		printVine(result.Configuration)

		if !openVineInBrowser {
			var confirm bool
			err := huh.NewConfirm().
				Title("Open in browser?").
				Affirmative("Yes").
				Negative("No").
				Value(&confirm).
				Run()
			if err == nil {
				openVineInBrowser = confirm
			}
		}

		if openVineInBrowser {
			url := fmt.Sprintf("%s/dashboard", webOrigin)
			fmt.Printf("Opening in browser: %s\n", url)
			if err := browser.OpenURL(url); err != nil {
				fmt.Printf("Error opening browser: %v\n", err)
			}
		}
	},
}

func init() {
	vineCmd.AddCommand(vineGetCmd)
	vineGetCmd.Flags().BoolVarP(&openVineInBrowser, "open", "o", false, "Open the vine in the web browser")
}

func printVine(config types.Configuration) {
	doc := strings.Builder{}

	var (
		headerStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("63")).Padding(1, 0)
		subHeaderStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("240")).Padding(0, 0, 0, 2)
		keyStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("244")).Padding(0, 2, 0, 4)
		valueStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("255"))
	)

	kv := func(key string, value string) string {
		return keyStyle.Render(key) + valueStyle.Render(value)
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
		return kv(key, value.Format("2006-01-02 15:04:05"))
	}

	doc.WriteString(headerStyle.Render("Vine Details"))
	doc.WriteString("\n")
	doc.WriteString(kv("Project:", config.ProjectName))
	doc.WriteString("\n")
	doc.WriteString(kv("Environment:", config.EnvironmentStage))
	doc.WriteString("\n")
	doc.WriteString(kv("Container Platform:", config.ContainerPlatform))
	doc.WriteString("\n")
	doc.WriteString(kvTime("Last Updated:", config.UpdatedAt))
	doc.WriteString("\n\n")

	doc.WriteString(subHeaderStyle.Render("Cloud Configuration"))
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
		doc.WriteString(kv("VPC CIDR:", *config.VpcCidr))
	}
	doc.WriteString("\n")
	doc.WriteString(kvBool("Enable DNS:", config.EnableDns))
	if config.EnableDns != nil && *config.EnableDns {
		doc.WriteString("\n")
		doc.WriteString(kv("Hosted Zone:", *config.DnsHostedZone))
		doc.WriteString("\n")
		doc.WriteString(kv("Domain Name:", *config.DnsDomainName))
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
		doc.WriteString(kv("Allowed CIDR Blocks:", *config.RedisAllowedCidrBlocks))
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
