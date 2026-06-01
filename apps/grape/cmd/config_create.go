package cmd

import (
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/api"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/types"
	"github.com/bobikenobi12/bb-thesis-2026/apps/grape/pkg/utils/ui"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/huh/spinner"
	"github.com/imroc/req/v3"
	"github.com/spf13/cobra"
)

var createConfigCmd = &cobra.Command{
	Use:   "create",
	Short: "Grow a new infrastructure vine (configuration)",
	Run: func(cmd *cobra.Command, args []string) {
		token, err := getAuthToken()
		if err != nil {
			fmt.Println(err)
			os.Exit(1)
		}
		apiClient := api.NewClient(token)

		// Defaults matching the web app/dummy config
		config := types.Configuration{
			TerraformVersion:               "1.15.5",
			AwsRegion:                      "us-east-1",
			EnvironmentStage:               "development",
			ContainerPlatform:              "standard",
			EnvTemplateRepo:                "https://github.com/itgix/adp-tf-envtempl-standard.git",
			EnvTemplateRepoBranch:          "main",
			GitopsTemplateRepo:             "https://github.com/itgix/adp-k8s-templ-argoinfrasvcs.git",
			GitopsTemplateRepoBranch:       "main",
			ApplicationsTemplateRepo:       "https://github.com/itgix/adp-k8s-templ-argoappsdemo.git",
			ApplicationsTemplateRepoBranch: "main",
		}

		steps := []string{"Vineyard & Basics", "Platform", "Repositories", "Network & Advanced", "Database", "Review"}

		// --- Form: Vineyard Selection ---
		ui.PrintStepper(steps, 0)
		
		var vResult struct {
			Vineyards []types.Vineyard `json:"vineyards"`
		}
		webOrigin := os.Getenv("GRAPE_WEB_ORIGIN")
		if webOrigin == "" {
			webOrigin = "https://adp.prod.itgix.eu"
		}
		reqClient := req.C()
		
		err = spinner.New().
			Title("Fetching your vineyards...").
			Action(func() {
				_, err = reqClient.R().
					SetBearerAuthToken(token).
					SetSuccessResult(&vResult).
					Get(fmt.Sprintf("%s/api/cli/vineyards", webOrigin))
			}).Run()

		if err != nil {
			fmt.Printf("Error: %v\n", err)
			return
		}

		if len(vResult.Vineyards) == 0 {
			fmt.Println("❌ No Vineyards found. Please create one first via `grape vineyard create`.")
			return
		}

		vOptions := make([]huh.Option[string], len(vResult.Vineyards))
		for i, v := range vResult.Vineyards {
			vOptions[i] = huh.NewOption(v.Name, v.ID)
		}

		var (
			vineyardID       string
			vineName         string
			envStage         string
			awsAccountID     string
			awsRegion        string
			terraformVersion string
		)

		formBasics := huh.NewForm(
			huh.NewGroup(
				huh.NewSelect[string]().
					Title("Vineyard Workspace").
					Description("Select the Vineyard where this vine will grow").
					Options(vOptions...).
					Value(&vineyardID),
				huh.NewInput().
					Title("Vine Name").
					Description("Enter a unique name for this infrastructure vine").
					Value(&vineName).
					Validate(func(str string) error {
						if len(str) < 3 {
							return fmt.Errorf("vine name must be at least 3 characters")
						}
						return nil
					}),
				huh.NewSelect[string]().
					Title("Environment Stage").
					Options(
						huh.NewOption("Development", "development"),
						huh.NewOption("Staging", "staging"),
						huh.NewOption("Production", "production"),
					).
					Value(&envStage),
				huh.NewInput().
					Title("AWS Account ID").
					Placeholder("123456789012").
					Value(&awsAccountID).
					Validate(func(str string) error {
						if len(str) != 12 {
							return fmt.Errorf("AWS Account ID must be 12 digits")
						}
						_, err := strconv.Atoi(str)
						if err != nil {
							return fmt.Errorf("AWS Account ID must be numeric")
						}
						return nil
					}),
				huh.NewSelect[string]().
					Title("AWS Region").
					Options(
						huh.NewOption("US East (N. Virginia)", "us-east-1"),
						huh.NewOption("US West (Oregon)", "us-west-2"),
						huh.NewOption("Europe (Ireland)", "eu-west-1"),
						huh.NewOption("Asia Pacific (Singapore)", "ap-southeast-1"),
					).
					Value(&awsRegion),
				huh.NewSelect[string]().
					Title("Terraform Version").
					Options(
						huh.NewOption("1.5.0", "1.5.0"),
						huh.NewOption("1.4.6", "1.4.6"),
						huh.NewOption("1.3.9", "1.3.9"),
					).
					Value(&terraformVersion),
			),
		)

		err = formBasics.Run()
		if err != nil {
			fmt.Println("Cancelled.")
			return
		}

		config.VineyardID = &vineyardID
		config.ProjectName = vineName
		config.EnvironmentStage = envStage
		config.AwsAccountID = awsAccountID
		config.AwsRegion = awsRegion
		config.TerraformVersion = terraformVersion

		// --- Form: Platform ---
		ui.PrintStepper(steps, 1)
		var containerPlatform string
		formPlatform := huh.NewForm(
			huh.NewGroup(
				huh.NewSelect[string]().
					Title("Container Platform").
					Options(
						huh.NewOption("Standard (General workloads)", "standard"),
						huh.NewOption("AI Workloads Ready", "ai-workloads"),
						huh.NewOption("Custom Template", "custom"),
					).
					Value(&containerPlatform),
			),
		)
		err = formPlatform.Run()
		if err != nil {
			return
		}
		config.ContainerPlatform = containerPlatform

		// --- Repository Selection ---
		ui.PrintStepper(steps, 2)
		// 1. Select Provider
		var provider string
		formProvider := huh.NewForm(
			huh.NewGroup(
				huh.NewSelect[string]().
					Title("Git Provider").
					Description("Select where your repositories are hosted").
					Options(
						huh.NewOption("GitHub", "github"),
						huh.NewOption("GitLab", "gitlab"),
						huh.NewOption("Bitbucket", "bitbucket"),
					).
					Value(&provider),
			),
		)
		err = formProvider.Run()
		if err != nil {
			return
		}

		// 2. Fetch Repositories
		var repos []api.Repository
		action := func() {
			repos, err = apiClient.GetRepositories(provider)
		}
		
		err = spinner.New().
			Title(fmt.Sprintf("Fetching %s repositories...", provider)).
			Action(action).
			Run()

		if err != nil {
			fmt.Printf("Warning: Error fetching repositories: %v. You can enter URL manually.\n", err)
		}

		repoOptions := make([]huh.Option[string], 0, len(repos))
		for _, r := range repos {
			repoOptions = append(repoOptions, huh.NewOption(r.FullName, r.URL))
		}
		repoOptions = append(repoOptions, huh.NewOption("Manual Entry", "manual"))

		var (
			envRepoURL    string
			gitopsRepoURL string
			appRepoURL    string
			gitopsToken   string
			appToken      string
			manualEnv     string
			manualGitops  string
			manualApp     string
		)

		formRepos := huh.NewForm(
			huh.NewGroup(
				huh.NewSelect[string]().
					Title("Environment Repository").
					Description("Destination for infrastructure code").
					Options(repoOptions...).
					Value(&envRepoURL),
				huh.NewInput().
					Title("Manual Environment Repo URL").
					Value(&manualEnv),
			).WithHideFunc(func() bool { return envRepoURL != "manual" }),
			huh.NewGroup(
				huh.NewSelect[string]().
					Title("GitOps Repository").
					Description("Destination for ArgoCD configurations").
					Options(repoOptions...).
					Value(&gitopsRepoURL),
				huh.NewInput().
					Title("Manual GitOps Repo URL").
					Value(&manualGitops),
			).WithHideFunc(func() bool { return gitopsRepoURL != "manual" }),
			huh.NewGroup(
				huh.NewInput().
					Title("GitOps Access Token").
					Description("Token for ArgoCD to access the repo").
					EchoMode(huh.EchoModePassword).
					Value(&gitopsToken),
			).Title("Repository Configuration"),
			huh.NewGroup(
				huh.NewSelect[string]().
					Title("Applications Repository (Optional)").
					Description("Destination for custom applications").
					Options(append([]huh.Option[string]{huh.NewOption("None", "")}, repoOptions...)...).
					Value(&appRepoURL),
				huh.NewInput().
					Title("Manual Applications Repo URL").
					Value(&manualApp),
				huh.NewInput().
					Title("Applications Access Token").
					Description("Required if Applications Repository is selected").
					EchoMode(huh.EchoModePassword).
					Value(&appToken),
			).WithHideFunc(func() bool { return appRepoURL != "manual" && appRepoURL != "" }),
		)

		err = formRepos.Run()
		if err != nil {
			return
		}

		if envRepoURL == "manual" { envRepoURL = manualEnv }
		if gitopsRepoURL == "manual" { gitopsRepoURL = manualGitops }
		if appRepoURL == "manual" { appRepoURL = manualApp }

		config.EnvironmentRepository = &envRepoURL
		config.EnvGitRepo = envRepoURL
		config.GitopsRepository = &gitopsRepoURL
		config.GitopsDestinationRepo = gitopsRepoURL
		config.GitopsDestinationsRepo = &gitopsRepoURL
		config.GitopsArgocdToken = &gitopsToken

		if appRepoURL != "" {
			config.ApplicationsDestinationRepo = appRepoURL
			config.GitopsAppToken = &appToken
		}

		// --- Network & Advanced ---
		ui.PrintStepper(steps, 3)
		var (
			createVPC       bool
			vpcCIDR         string
			enableDNS       bool
			dnsZone         string
			dnsDomain       string
			enableWAF       bool
			enableRedis     bool
			redisCIDR       string
			enableKarpenter bool
			dbMin           string = "2"
			dbMax           string = "16"
		)

		formNetwork := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title("Create new VPC?").
					Value(&createVPC),
				huh.NewInput().
					Title("VPC CIDR").
					Value(&vpcCIDR).
					Validate(func(str string) error {
						if str == "" { return nil }
						if !strings.Contains(str, "/") { return fmt.Errorf("invalid CIDR format") }
						return nil
					}),
			).Title("Network"),
			huh.NewGroup(
				huh.NewConfirm().
					Title("Enable DNS?").
					Value(&enableDNS),
				huh.NewInput().
					Title("Hosted Zone ID").
					Value(&dnsZone),
				huh.NewInput().
					Title("Domain Name").
					Value(&dnsDomain),
			).Title("DNS"),
			huh.NewGroup(
				huh.NewConfirm().
					Title("Enable CloudFront WAF?").
					Value(&enableWAF),
				huh.NewConfirm().
					Title("Enable Redis?").
					Value(&enableRedis),
				huh.NewInput().
					Title("Redis Allowed CIDR Blocks").
					Value(&redisCIDR).
					Placeholder("10.0.0.0/16"),
				huh.NewConfirm().
					Title("Enable Karpenter Auto-Scaling?").
					Value(&enableKarpenter),
			).Title("Advanced"),
		)

		vpcCIDR = "10.0.0.0/16"
		redisCIDR = "10.0.0.0/16"
		enableKarpenter = true
		createVPC = true

		err = formNetwork.Run()
		if err != nil {
			return
		}

		config.CreateVpc = &createVPC
		config.VpcCidr = &vpcCIDR
		config.EnableDns = &enableDNS
		if enableDNS {
			config.DnsHostedZone = &dnsZone
			config.DnsDomainName = &dnsDomain
		}
		config.EnableCloudfrontWaf = &enableWAF
		config.EnableRedis = &enableRedis
		if enableRedis {
			config.RedisAllowedCidrBlocks = &redisCIDR
		}
		config.EnableKarpenter = &enableKarpenter
		
		// --- Database ---
		ui.PrintStepper(steps, 4)
		formDB := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("DB Min Capacity").
					Value(&dbMin),
				huh.NewInput().
					Title("DB Max Capacity").
					Value(&dbMax),
			).Title("Database"),
		)
		err = formDB.Run()
		if err != nil {
			return
		}

		minInt, _ := strconv.Atoi(dbMin)
		maxInt, _ := strconv.Atoi(dbMax)
		minCap := float64(minInt)
		maxCap := float64(maxInt)
		config.DbMinCapacity = &minCap
		config.DbMaxCapacity = &maxCap

		// --- Summary & Submit ---
		ui.PrintStepper(steps, 5)
		ui.PrintConfiguration(config)
		
		var confirm bool
		err = huh.NewConfirm().
			Title("Plant this infrastructure vine?").
			Value(&confirm).
			Run()
		
		if err != nil || !confirm {
			fmt.Println("Cancelled.")
			return
		}

		// Submit
		var createdConfig *types.Configuration
		actionCreate := func() {
			createdConfig, err = apiClient.CreateConfiguration(config)
		}

		err = spinner.New().
			Title("Planting vine...").
			Action(actionCreate).
			Run()

		if err != nil {
			fmt.Printf("\nError planting vine: %v\n", err)
			os.Exit(1)
		}

		if createdConfig == nil {
			fmt.Println("\nError: Vine planted but no response received.")
			os.Exit(1)
		}

		fmt.Printf("\n✓ Vine planted successfully! (ID: %s)\n", createdConfig.ID)
		fmt.Printf("\nTo harvest this vine, run:\n  grape harvest --vine-id %s --cluster-id <id>\n", createdConfig.ID)
	},
}

func init() {
	configCmd.AddCommand(createConfigCmd)
}
