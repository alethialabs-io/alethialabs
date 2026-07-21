// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package infracost

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/alethialabs-io/alethialabs/packages/core/utils"
)

// maxDownloadBytes bounds the Infracost release download so a stalled or oversized response can't
// exhaust memory (the tarball is ~20 MiB; 200 MiB is a generous ceiling).
const maxDownloadBytes = 200 << 20

const (
	// DefaultInfracostVersion is the Infracost CLI version the runtime fallback downloads when the
	// binary isn't already on PATH. Production bakes it into the runner image (Dockerfile.base's
	// ARG INFRACOST_VERSION) — this constant is the native/dev fallback and should match that ARG.
	DefaultInfracostVersion = "v0.10.39"
	// InfracostVersionEnv overrides DefaultInfracostVersion (mirrors ALETHIA_IAC_VERSION for tofu).
	InfracostVersionEnv = "ALETHIA_INFRACOST_VERSION"
)

// ResolvedInfracostVersion returns ALETHIA_INFRACOST_VERSION when set, else DefaultInfracostVersion
// — a single config-driven source, never a hardcoded per-call literal.
func ResolvedInfracostVersion() string {
	if v := strings.TrimSpace(os.Getenv(InfracostVersionEnv)); v != "" {
		return v
	}
	return DefaultInfracostVersion
}

var (
	// httpGet carries a timeout so a stalled release download can never hang a provisioning job
	// forever (the default http.Get has no timeout). Overridden in tests.
	httpGet        = (&http.Client{Timeout: 5 * time.Minute}).Get
	executeCommand = utils.ExecuteCommand
)

// InfracostCLI represents the Infracost CLI wrapper.
type InfracostCLI struct {
	Version    string
	binaryPath string
	apiKey     string
}

// NewInfracostCLI creates a new Infracost CLI wrapper.
func NewInfracostCLI(version string, apiKey string) *InfracostCLI {
	return &InfracostCLI{
		Version: version,
		apiKey:  apiKey,
	}
}

// CheckToken verifies if the Infracost API token is set.
func (i *InfracostCLI) CheckToken() bool {
	if i.apiKey == "" {
		fmt.Println("Warning: Infracost token not provided. Skipping cost estimation.")
		fmt.Println("To include Infracost, set the INFRACOST_API_KEY environment variable.")
		return false
	}
	return true
}

// ensureBinary checks if the Infracost binary exists and downloads it if not.
func (i *InfracostCLI) ensureBinary() error {
	binDir := "bin"
	absBinDir, err := filepath.Abs(binDir)
	if err != nil {
		return fmt.Errorf("failed to get absolute path for bin directory: %w", err)
	}

	i.binaryPath = filepath.Join(absBinDir, fmt.Sprintf("infracost_%s", i.Version))
	if _, err := os.Stat(i.binaryPath); err == nil {
		fmt.Printf("Infracost %s is already available.\n", i.Version)
		return nil
	}

	// Create bin directory if it doesn't exist
	if err := os.MkdirAll(absBinDir, 0755); err != nil {
		return fmt.Errorf("failed to create bin directory: %w", err)
	}

	return i.download(absBinDir)
}

func (i *InfracostCLI) download(binDir string) error {
	arch := runtime.GOARCH
	goos := runtime.GOOS

	downloadURL := fmt.Sprintf("https://github.com/infracost/infracost/releases/download/%s/infracost-%s-%s.tar.gz", i.Version, goos, arch)
	fmt.Printf("Downloading Infracost %s for %s-%s...\n", i.Version, goos, arch)

	tarBytes, err := fetchBounded(downloadURL, "infracost")
	if err != nil {
		return err
	}

	// Supply-chain: verify the published SHA256 before extracting + executing the binary. The runner
	// image bakes a checksum-verified copy; this guards the native/dev fallback download.
	if err := verifyInfracostChecksum(downloadURL, tarBytes); err != nil {
		return err
	}

	gzReader, err := gzip.NewReader(bytes.NewReader(tarBytes))
	if err != nil {
		return fmt.Errorf("failed to create gzip reader: %w", err)
	}
	defer gzReader.Close()

	tarReader := tar.NewReader(gzReader)
	outPath := filepath.Join(binDir, "infracost")
	extracted := false
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("failed to read tar header: %w", err)
		}
		if header.Typeflag == tar.TypeReg && strings.Contains(header.Name, "infracost") {
			outFile, err := os.Create(outPath)
			if err != nil {
				return fmt.Errorf("failed to create infracost binary: %w", err)
			}
			if _, err := io.Copy(outFile, tarReader); err != nil {
				outFile.Close()
				return fmt.Errorf("failed to write infracost binary: %w", err)
			}
			outFile.Close()
			extracted = true
			break
		}
	}
	if !extracted {
		return fmt.Errorf("infracost binary not found in the downloaded archive")
	}

	i.binaryPath = outPath
	if err := os.Chmod(i.binaryPath, 0755); err != nil {
		return fmt.Errorf("failed to make infracost binary executable: %w", err)
	}

	fmt.Println("Infracost downloaded and verified successfully.")
	return nil
}

// fetchBounded GETs url and returns up to maxDownloadBytes of the body, erroring on a transport
// failure or a non-200 status.
func fetchBounded(url, what string) ([]byte, error) {
	resp, err := httpGet(url)
	if err != nil {
		return nil, fmt.Errorf("failed to download %s: %w", what, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to download %s: status code %d", what, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxDownloadBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", what, err)
	}
	return b, nil
}

// verifyInfracostChecksum fetches the release's per-asset "<url>.sha256" and checks it against the
// downloaded tarball (Infracost publishes "infracost-<os>-<arch>.tar.gz.sha256" per asset).
func verifyInfracostChecksum(downloadURL string, tarBytes []byte) error {
	sumBytes, err := fetchBounded(downloadURL+".sha256", "infracost checksum")
	if err != nil {
		return err
	}
	fields := strings.Fields(string(sumBytes))
	if len(fields) == 0 {
		return fmt.Errorf("infracost checksum file was empty")
	}
	got := fmt.Sprintf("%x", sha256.Sum256(tarBytes))
	if !strings.EqualFold(fields[0], got) {
		return fmt.Errorf("infracost checksum mismatch: got %s, want %s", got, fields[0])
	}
	return nil
}

// RunInfracost executes infracost breakdown and returns structured cost data.
// Also writes the JSON and table files to temp/ for backward compatibility.
func (i *InfracostCLI) RunInfracost(planFile string, env []string) (*CostBreakdown, error) {
	if !i.CheckToken() {
		return nil, nil
	}

	fmt.Println("Running Infracost cost estimation...")

	if err := i.ensureBinary(); err != nil {
		return nil, fmt.Errorf("failed to ensure infracost binary: %w", err)
	}

	tempDir := "temp"
	if err := os.MkdirAll(tempDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create temp directory: %w", err)
	}
	breakdownJSONPath := filepath.Join(tempDir, "infracost_breakdown.json")

	// binaryPath, planFile and breakdownJSONPath are interpolated into a `bash -c` command string;
	// shell-quote each so a path containing shell metacharacters can't inject (command-injection
	// guard, #944). planFile is caller-supplied, so this is the value that matters most.
	breakdownCmd := fmt.Sprintf("%s breakdown --path %s --format json --out-file %s",
		utils.ShellQuote(i.binaryPath), utils.ShellQuote(planFile), utils.ShellQuote(breakdownJSONPath))
	if err := executeCommand(breakdownCmd, ".", env, nil, nil); err != nil {
		return nil, fmt.Errorf("infracost breakdown failed: %w", err)
	}

	data, err := os.ReadFile(breakdownJSONPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read infracost output: %w", err)
	}

	breakdown, err := ParseCostBreakdown(data)
	if err != nil {
		return nil, err
	}

	if breakdown.Summary != nil {
		fmt.Printf("Cost Summary — Monthly: $%.2f, Diff: $%.2f (%d resources with cost, %d free)\n",
			breakdown.Summary.TotalMonthly,
			breakdown.Summary.DiffMonthly,
			breakdown.Summary.ResourcesWithCost,
			breakdown.Summary.ResourcesFree,
		)
	}

	return breakdown, nil
}
