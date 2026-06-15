// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/types"
	"github.com/alethialabs-io/alethialabs/apps/cli/pkg/utils/ui"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/huh"
	"github.com/charmbracelet/lipgloss"
	"github.com/google/uuid"
	"github.com/imroc/req/v3"
	"github.com/pkg/browser"
	"github.com/spf13/cobra"
)

// --- Preferences for UI ---

type cliPreferences struct {
	HideLoginWarning bool `json:"hide_login_warning"`
}

func getPreferencesPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, "alethia", "preferences.json"), nil
}

func loadPreferences() cliPreferences {
	var prefs cliPreferences
	path, err := getPreferencesPath()
	if err == nil {
		data, err := os.ReadFile(path)
		if err == nil {
			json.Unmarshal(data, &prefs)
		}
	}
	return prefs
}

func savePreferences(prefs cliPreferences) {
	path, err := getPreferencesPath()
	if err == nil {
		os.MkdirAll(filepath.Dir(path), 0755)
		data, _ := json.MarshalIndent(prefs, "", "  ")
		os.WriteFile(path, data, 0644)
	}
}

// --- Bubble Tea Model ---

type model struct {
	spinner   spinner.Model
	loading   bool
	done      bool
	err       error
	userEmail string
}

func initialModel() model {
	s := spinner.New()
	s.Spinner = spinner.Dot
	return model{
		spinner: s,
		loading: true,
	}
}

func (m model) Init() tea.Cmd {
	return m.spinner.Tick
}

type authSuccessMsg struct{ response *types.ExchangeResponse }
type authErrorMsg struct{ err error }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		if msg.Type == tea.KeyCtrlC || msg.Type == tea.KeyEsc {
			return m, tea.Quit
		}
	case authSuccessMsg:
		m.loading = false
		m.done = true
		m.userEmail = msg.response.UserEmail
		saveTokens(msg.response)
		return m, tea.Quit
	case authErrorMsg:
		m.loading = false
		m.err = msg.err
		return m, tea.Quit
	default:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}
	return m, nil
}

func (m model) View() string {
	if m.loading {
		return fmt.Sprintf("%s Waiting for authentication in the browser...", m.spinner.View())
	}
	if m.done {
		return ui.FormatSuccess(fmt.Sprintf("Welcome, %s! You are now authenticated.", m.userEmail)) + "\n"
	}
	if m.err != nil {
		return ui.FormatError(fmt.Sprintf("Error: %v", m.err)) + "\n"
	}
	return ""
}

// --- Polling and Token Handling ---

func pollForToken(deviceCode, exchangeURL string) tea.Cmd {
	return func() tea.Msg {
		client := req.C().SetTimeout(120 * time.Second) // Overall timeout for the polling
		for {
			var result types.ExchangeResponse
			var errMsg struct {
				Error string `json:"error"`
			}
			resp, err := client.R().
				SetBody(map[string]string{"device_code": deviceCode}).
				SetSuccessResult(&result).
				SetErrorResult(&errMsg).
				Post(exchangeURL)

			if err != nil {
				return authErrorMsg{err: fmt.Errorf("failed to connect to server: %w", err)}
			}

			if resp.IsSuccessState() {
				return authSuccessMsg{response: &result}
			}

			if resp.StatusCode != 404 { // 404 is our "pending" state, any other error is fatal
				return authErrorMsg{err: fmt.Errorf("authentication failed (HTTP %d): %s", resp.StatusCode, errMsg.Error)}
			}

			// If it's a 404, just wait and try again
			time.Sleep(2 * time.Second)
		}
	}
}



func saveTokens(tokens *types.ExchangeResponse) {
	credsPath, err := getCredentialsPath()
	if err != nil {
		fmt.Printf("Error getting credentials path: %v\n", err)
		os.Exit(1)
	}

	if err := os.MkdirAll(filepath.Dir(credsPath), 0755); err != nil {
		fmt.Printf("Error creating config directory: %v\n", err)
		os.Exit(1)
	}

	file, err := os.Create(credsPath)
	if err != nil {
		fmt.Printf("Error creating credentials file: %v\n", err)
		os.Exit(1)
	}
	defer file.Close()

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(tokens); err != nil {
		fmt.Printf("Error writing tokens to file: %v\n", err)
		os.Exit(1)
	}
}

// --- Login Flow Implementation ---

func performLoginFlow() error {
	prefs := loadPreferences()

	if !prefs.HideLoginWarning {
		infoBox := lipgloss.NewStyle().Foreground(lipgloss.Color(ui.ColorText)).Border(lipgloss.RoundedBorder()).Padding(1, 2).BorderForeground(lipgloss.Color(ui.ColorAccent))

		msg := fmt.Sprintf("To use the Alethia CLI, you must have an account on the Alethia.\nIf you don't have one, register at:\n%s", ui.LinkStyle.Render(WebOrigin()+"/auth/signin"))
		fmt.Println(infoBox.Render(msg))
		fmt.Println()

		var hideWarning bool
		err := huh.NewForm(
			huh.NewGroup(
				huh.NewConfirm().
					Title("Hide this message in the future?").
					Value(&hideWarning),
			),
		).Run()

		if err == nil && hideWarning {
			prefs.HideLoginWarning = true
			savePreferences(prefs)
		}
		fmt.Println()
	}

	deviceCode := uuid.New().String()
	origin := WebOrigin()
	loginURL := fmt.Sprintf("%s/cli/login?device_code=%s", origin, deviceCode)
	exchangeURL := fmt.Sprintf("%s/api/auth/cli/exchange", origin)

	fmt.Println(ui.CyanStyle.Render("Please open the following URL in your browser to log in:"))
	fmt.Println(loginURL)

	if err := browser.OpenURL(loginURL); err != nil {
		fmt.Printf("\nCould not open browser automatically. Please open the link manually.\n")
	}

	p := tea.NewProgram(initialModel())
	go func() {
		// This is a bit of a hack to ensure the Bubble Tea UI has time to render before polling starts
		time.Sleep(100 * time.Millisecond)
		p.Send(pollForToken(deviceCode, exchangeURL)())
	}()

	if _, err := p.Run(); err != nil {
		return fmt.Errorf("an error occurred during login: %w", err)
	}
	return nil
}

// --- Cobra Command ---

var forceLogin bool

var loginCmd = &cobra.Command{
	Use:   "login",
	Short: "Authenticate with the platform",
	Run: func(cmd *cobra.Command, args []string) {
		// 1. Check if already authenticated (unless forced)
		if !forceLogin {
			if _, err := getAuthTokenInternal(false); err == nil {
				// We need to fetch the email for display purposes since getAuthToken returns only the token
				credsPath, _ := getCredentialsPath()
				file, _ := os.ReadFile(credsPath)
				var creds types.ExchangeResponse
				json.Unmarshal(file, &creds)
				
					fmt.Println(ui.TextStyle.Render(fmt.Sprintf("You are already logged in as: %s", ui.CyanStyle.Render(creds.UserEmail))))
				fmt.Println(ui.TextStyle.Render("Use --force to log in again."))
				return
			}
		}

		// 2. Proceed with login flow
		if err := performLoginFlow(); err != nil {
			ui.Error(err.Error())
			os.Exit(1)
		}
	},
}

func init() {
	rootCmd.AddCommand(loginCmd)
	loginCmd.Flags().BoolVarP(&forceLogin, "force", "f", false, "Force re-authentication")
}
