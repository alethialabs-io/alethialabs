// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"os"

	"github.com/alethialabs-io/alethialabs/apps/cli/internal/version"
	"github.com/charmbracelet/lipgloss"
	"github.com/spf13/cobra"
)

func init() {
	rootCmd.Version = version.Version
}

var rootCmd = &cobra.Command{
	Use:   "alethia",
	Short: "alethia is a CLI for managing your infrastructure",
	Long: `Alethia encompasses a CLI (alethia) and a Web Control Plane (console).
It helps you automate, manage, and scale your cloud infrastructure easily.`,
	Run: func(cmd *cobra.Command, args []string) {
		logo := `
   ______                           
  / ____/________ _____  ___        
 / / __/ ___/ __ ` + "`" + `/ __ \/ _ \       
/ /_/ / /  / /_/ / /_/ /  __/       
\____/_/   \__,_/ .___/\___/        
               /_/                  
`
		logoStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("63")).Bold(true)
		titleStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("205")).Bold(true)
		linkStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("39")).Underline(true)
		textStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("252"))
		accentStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("86")).Bold(true)

		fmt.Println(logoStyle.Render(logo))
		fmt.Println(titleStyle.Render("Welcome to the Alethia CLI!"))
		fmt.Println()
		
		fmt.Println(textStyle.Render("Developed by: ") + accentStyle.Render("Borislav Borisov"))
		fmt.Println(textStyle.Render("Email:        ") + linkStyle.Render("borislav@tovr.eu"))
		fmt.Println(textStyle.Render("GitHub:       ") + linkStyle.Render("https://github.com/bobikenobi12"))
		fmt.Println(textStyle.Render("LinkedIn:     ") + linkStyle.Render("https://www.linkedin.com/in/bborisov1/"))
		fmt.Println()
		fmt.Println(textStyle.Render("This tool is open source and I'd love collaboration."))
		fmt.Println(textStyle.Render("Alethia is designed to manage, provision, and automate complex cloud infrastructure effortlessly."))
		fmt.Println(textStyle.Render("You can also set up things through our web platform: ") + linkStyle.Render("https://trellis.itgix.eu"))
		fmt.Println()

		cmd.Help()
	},
}

const defaultWebOrigin = "https://beta.adp.itgix.com"

func WebOrigin() string {
	if v := os.Getenv("ALETHIA_WEB_ORIGIN"); v != "" {
		return v
	}
	return defaultWebOrigin
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}
