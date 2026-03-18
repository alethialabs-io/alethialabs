package cmd

import (
	"fmt"
	"os"

	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
)

var logoutCmd = &cobra.Command{
	Use:   "logout",
	Short: "Log out from the platform",
	Run: func(cmd *cobra.Command, args []string) {
		successStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("42")).Bold(true)
		infoStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("252"))
		accentStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("39")).Bold(true)
		errorStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("196")).Bold(true)

		credsPath, err := getCredentialsPath()
		if err != nil {
			fmt.Println(errorStyle.Render(fmt.Sprintf("Error getting credentials path: %v", err)))
			os.Exit(1)
		}

		if _, err := os.Stat(credsPath); os.IsNotExist(err) {
			fmt.Println(infoStyle.Render("You are not currently logged in."))
			return
		}

		if err := os.Remove(credsPath); err != nil {
			fmt.Println(errorStyle.Render(fmt.Sprintf("Error logging out: %v", err)))
			os.Exit(1)
		}

		fmt.Println(successStyle.Render("✔ Successfully logged out."))
		fmt.Println(infoStyle.Render("If you want to log back in, run ") + accentStyle.Render("grape login"))
	},
}

func init() {
	rootCmd.AddCommand(logoutCmd)
}


