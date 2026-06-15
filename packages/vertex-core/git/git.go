package git

import (
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/bobikenobi12/bb-thesis-2026/packages/vertex-core/utils"
	"github.com/flosch/pongo2/v6"
	gogit "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/transport"
	githttp "github.com/go-git/go-git/v5/plumbing/transport/http"
	"github.com/go-git/go-git/v5/plumbing/transport/ssh"
)

var (
	ErrRepoNotFound = errors.New("repository not found")
	ErrRepoEmpty    = errors.New("remote repository is empty")
	ErrAuthFailed   = errors.New("authentication failed")
)

// GIT represents a Git repository wrapper.
type GIT struct {
	RepoURL   string
	LocalPath string
	Repo      *gogit.Repository
	DryRun    bool
	Token     string
}

// NewGIT creates a new GIT wrapper.
func NewGIT(repoURL string, localPath string, dryRun bool) *GIT {
	return &GIT{
		RepoURL:   transformURLToSSH(repoURL),
		LocalPath: localPath,
		DryRun:    dryRun,
	}
}

// NewGITWithToken creates a GIT wrapper that uses HTTPS + token auth.
func NewGITWithToken(repoURL string, localPath string, dryRun bool, token string) *GIT {
	return &GIT{
		RepoURL:   transformURLToHTTPS(repoURL),
		LocalPath: localPath,
		DryRun:    dryRun,
		Token:     token,
	}
}

// transformURLToSSH converts an HTTP/HTTPS URL to SSH format.
func transformURLToSSH(rawURL string) string {
	// If URL is already in SSH format, return as is.
	if strings.HasPrefix(rawURL, "git@") {
		return rawURL
	}

	u, err := url.Parse(rawURL)
	if err != nil {
		fmt.Printf("Warning: Failed to parse Git URL '%s': %v. Returning original URL.\n", rawURL, err)
		return rawURL
	}

	// Construct the SSH URL: git@host:path/to/repo.git
	sshURL := fmt.Sprintf("git@%s:%s", u.Host, strings.TrimPrefix(u.Path, "/"))

	// Ensure it ends with .git
	if !strings.HasSuffix(sshURL, ".git") {
		sshURL += ".git"
	}

	return sshURL
}

// transformURLToHTTPS converts an SSH or other URL to HTTPS format.
func transformURLToHTTPS(rawURL string) string {
	if strings.HasPrefix(rawURL, "git@") {
		// git@github.com:owner/repo.git -> https://github.com/owner/repo.git
		rawURL = strings.TrimPrefix(rawURL, "git@")
		rawURL = strings.Replace(rawURL, ":", "/", 1)
		return "https://" + rawURL
	}
	if strings.HasPrefix(rawURL, "https://") || strings.HasPrefix(rawURL, "http://") {
		return rawURL
	}
	return "https://" + rawURL
}

// getAuthMethod returns the appropriate auth method for this GIT instance.
func (g *GIT) getAuth() (transport.AuthMethod, error) {
	if g.Token != "" {
		return &githttp.BasicAuth{
			Username: "x-access-token",
			Password: g.Token,
		}, nil
	}
	return getSSHAuthMethod()
}

func getSSHAuthMethod() (transport.AuthMethod, error) {
	auth, err := ssh.NewSSHAgentAuth("git")
	if err != nil {
		return nil, fmt.Errorf("failed to create SSH agent auth: %w", err)
	}
	return auth, nil
}

// getAuthMethod creates an SSH authentication method from the default SSH agent.
// Deprecated: use g.getAuth() instead.
func getAuthMethod() (transport.AuthMethod, error) {
	return getSSHAuthMethod()
}

// Clone clones a repository or opens an existing one.
func (g *GIT) Clone(branch string, force bool) error {
	fmt.Printf("Cloning %s into %s...\n", g.RepoURL, g.LocalPath)

	if _, err := os.Stat(g.LocalPath); err == nil && !force && g.isCorrectRepo() {
		// Repository already exists and is correct, open it
		repo, err := gogit.PlainOpen(g.LocalPath)
		if err != nil {
			return fmt.Errorf("failed to open existing repository '%s': %w", g.LocalPath, err)
		}
		g.Repo = repo

		// Checkout branch if specified
		if branch != "" {
			w, err := g.Repo.Worktree()
			if err != nil {
				return fmt.Errorf("failed to get worktree: %w", err)
			}
			err = w.Checkout(&gogit.CheckoutOptions{
				Branch:  plumbing.NewBranchReferenceName(branch),
			})
			if err != nil {
				// If branch checkout fails, try to fetch it first
				fetchOptions := &gogit.FetchOptions{
					RemoteName: "origin",
					RefSpecs: []config.RefSpec{config.RefSpec(fmt.Sprintf("+refs/heads/%s:refs/remotes/origin/%s", branch, branch))},
					Auth:       nil,
				}
				auth, authErr := g.getAuth()
				if authErr == nil {
					fetchOptions.Auth = auth
				}
				_ = g.Repo.Fetch(fetchOptions)

				err = w.Checkout(&gogit.CheckoutOptions{
					Branch:  plumbing.NewBranchReferenceName(branch),
				})
				if err != nil {
					return fmt.Errorf("failed to checkout branch '%s' after fetch attempt: %w", branch, err)
				}
			}
		}
		g.ResetAndRestoreChanges() // Discard local changes and untracked files
		return g.Pull()
	} else {
		// Remove existing directory if not correct repo or force is true
		_ = os.RemoveAll(g.LocalPath)
		_ = os.MkdirAll(g.LocalPath, 0755)

		auth, err := g.getAuth()
		if err != nil {
			fmt.Printf("Warning: Could not get auth method: %v. Attempting public clone.\n", err)
		}

		cloneOptions := &gogit.CloneOptions{
			URL:           g.RepoURL,
			ReferenceName: plumbing.NewBranchReferenceName(branch),
			SingleBranch:  true,
			Depth:         1,
			Progress:      os.Stdout,
			Auth:          auth,
		}

		if branch == "" {
			cloneOptions.ReferenceName = ""
			cloneOptions.SingleBranch = false
		}

		repo, err := gogit.PlainClone(g.LocalPath, false, cloneOptions)
		if err != nil {
			if errors.Is(err, transport.ErrRepositoryNotFound) {
				return fmt.Errorf("%w: %s", ErrRepoNotFound, g.RepoURL)
			}
			if errors.Is(err, transport.ErrEmptyRemoteRepository) {
				return fmt.Errorf("%w: %s", ErrRepoEmpty, g.RepoURL)
			}
			if errors.Is(err, transport.ErrAuthorizationFailed) || errors.Is(err, transport.ErrAuthenticationRequired) {
				return fmt.Errorf("%w: %s", ErrAuthFailed, g.RepoURL)
			}
			return fmt.Errorf("failed to clone repository '%s': %w", g.RepoURL, err)
		}
		g.Repo = repo
	}
	return nil
}

// isCorrectRepo checks if the local path contains the correct repository.
func (g *GIT) isCorrectRepo() bool {
	repo, err := gogit.PlainOpen(g.LocalPath)
	if err != nil {
		return false
	}

	remotes, err := repo.Remotes()
	if err != nil {
		return false
	}

	for _, r := range remotes {
		for _, u := range r.Config().URLs {
			if u == g.RepoURL {
				return true
			}
		}
	}
	return false
}

// Pull pulls the latest changes from the remote repository.
func (g *GIT) Pull() error {
	if g.Repo == nil {
		return fmt.Errorf("repository not initialized")
	}
	fmt.Printf("Pulling changes for %s...\n", g.RepoURL)

	w, err := g.Repo.Worktree()
	if err != nil {
		return fmt.Errorf("failed to get worktree: %w", err)
	}

	pullOptions := &gogit.PullOptions{
		RemoteName: "origin",
	}

	auth, err := g.getAuth()
	if err == nil {
		pullOptions.Auth = auth
	}

	err = w.Pull(pullOptions)
	if err != nil && err != gogit.NoErrAlreadyUpToDate {
		if err == transport.ErrEmptyRemoteRepository {
			fmt.Printf("Remote repository %s is empty.\n", g.RepoURL)
			return nil
		}
		return fmt.Errorf("failed to pull changes: %w", err)
	}

	fmt.Println("Pulled latest changes.")
	return nil
}

// Push pushes local commits to the remote repository.
func (g *GIT) Push() error {
	if g.Repo == nil {
		return fmt.Errorf("repository not initialized")
	}

	if g.DryRun {
		fmt.Printf("Dry-run mode: Skipping actual push for %s.\n", g.RepoURL)
		return nil
	}

	fmt.Printf("Pushing changes to %s...\n", g.RepoURL)
	auth, err := g.getAuth()
	if err != nil {
		return fmt.Errorf("failed to get auth method for push: %w", err)
	}

	pushOptions := &gogit.PushOptions{
		RemoteName: "origin",
		Auth:       auth,
	}

	err = g.Repo.Push(pushOptions)
	if err != nil && err != gogit.NoErrAlreadyUpToDate {
		return fmt.Errorf("failed to push changes: %w", err)
	}

	fmt.Println("Pushed changes successfully.")
	return nil
}

// AddAndCommit stages all changes and commits them.
func (g *GIT) AddAndCommit(message string) error {
	if g.Repo == nil {
		return fmt.Errorf("repository not initialized")
	}

	if g.DryRun {
		fmt.Printf("Dry-run mode: Skipping commit for %s.\n", g.RepoURL)
		return nil
	}

	w, err := g.Repo.Worktree()
	if err != nil {
		return fmt.Errorf("failed to get worktree: %w", err)
	}

	// Add all changes
	_, err = w.Add(".")
	if err != nil {
		return fmt.Errorf("failed to add changes to git index: %w", err)
	}

	// Commit changes
	_, err = w.Commit(message, &gogit.CommitOptions{})
	if err != nil {
		return fmt.Errorf("failed to commit changes: %w", err)
	}

	fmt.Printf("Committed changes with message: '%s'\n", message)
	return nil
}

// ResetAndRestoreChanges discards local changes and untracked files.
func (g *GIT) ResetAndRestoreChanges() error {
	if g.Repo == nil {
		return fmt.Errorf("repository not initialized")
	}

	w, err := g.Repo.Worktree()
	if err != nil {
		return fmt.Errorf("failed to get worktree: %w", err)
	}

	// Discard all changes in the working directory and staging area
	err = w.Reset(&gogit.ResetOptions{
		Mode: gogit.HardReset,
	})
	if err != nil {
		return fmt.Errorf("failed to reset worktree: %w", err)
	}

	// Clean untracked files and directories
	err = w.Clean(&gogit.CleanOptions{
		Dir: true, // Clean untracked directories
	})
	if err != nil {
		return fmt.Errorf("failed to clean worktree: %w", err)
	}

	fmt.Println("Reset staged and restored all changes.")
	return nil
}

// IsDirty checks if the repository has uncommitted changes or untracked files.
func (g *GIT) IsDirty() (bool, error) {
	if g.Repo == nil {
		return false, fmt.Errorf("repository not initialized")
	}
	w, err := g.Repo.Worktree()
	if err != nil {
		return false, fmt.Errorf("failed to get worktree: %w", err)
	}

	s, err := w.Status()
	if err != nil {
		return false, fmt.Errorf("failed to get worktree status: %w", err)
	}

	return !s.IsClean(), nil
}

// FileExists checks if a file exists within the local repository path.
func (g *GIT) FileExists(relativePath string) bool {
	fullPath := filepath.Join(g.LocalPath, relativePath)
	_, err := os.Stat(fullPath)
	return !os.IsNotExist(err)
}

// CopyFiles copies files from source to destination, ignoring specified files.
func (g *GIT) CopyFiles(src, dst string, ignoreFiles []string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}

		// Check if the file/directory should be ignored
		for _, ignore := range ignoreFiles {
			if relPath == ignore || strings.HasPrefix(relPath, ignore+"/") {
				if info.IsDir() {
					return filepath.SkipDir
				} else {
					return nil
				}
			}
		}

		destPath := filepath.Join(dst, relPath)

		if info.IsDir() {
			return os.MkdirAll(destPath, info.Mode())
		}

		srcFile, err := os.Open(path)
		if err != nil {
			return err
		}
		defer srcFile.Close()

		dstFile, err := os.Create(destPath)
		if err != nil {
			return err
		}
		defer dstFile.Close()

		_, err = io.Copy(dstFile, srcFile)
		return err
	})
}

// ClearRepoContents removes all files and directories (except .git) from the local repository path.
func (g *GIT) ClearRepoContents() error {
	// Ensure the local path exists and is a directory
	if info, err := os.Stat(g.LocalPath); os.IsNotExist(err) || !info.IsDir() {
		return fmt.Errorf("local path %s does not exist or is not a directory", g.LocalPath)
	}

	dirEntries, err := os.ReadDir(g.LocalPath)
	if err != nil {
		return fmt.Errorf("failed to read local repository directory: %w", err)
	}

	for _, entry := range dirEntries {
		if entry.Name() != ".git" {
			itemPath := filepath.Join(g.LocalPath, entry.Name())
			if err := os.RemoveAll(itemPath); err != nil {
				return fmt.Errorf("failed to remove %s: %w", itemPath, err)
			}
		}
	}
	return nil
}

// Bootstrap bootstraps the infrastructure-as-code repository.
func (g *GIT) Bootstrap(templateRepo *GIT, repoFilesMap map[string]string, updateRepo bool, logger *utils.Logger) error {
	logger.Info(fmt.Sprintf("Bootstrapping infrastructure-as-code git repository into %s...", g.LocalPath), "git")
	changes := false
	ignoreFiles := []string{".git", "variable-template"}

	if !g.FileExists("main.tf") {
		logger.Info("Initial infrastructure repo bootstrap", "git")
		if err := g.ClearRepoContents(); err != nil {
			return err
		}
		if err := g.CopyFiles(templateRepo.LocalPath, g.LocalPath, ignoreFiles); err != nil {
			return err
		}
		changes = true
	} else if updateRepo {
		logger.Info("Updating repo due to update flag", "git")
		if err := g.CopyFiles(templateRepo.LocalPath, g.LocalPath, ignoreFiles); err != nil {
			return err
		}
		changes = true
	} else {
		logger.Warn("main.tf file exists and will not overwrite!", "git")
	}

	for varFileSrc, varFileDst := range repoFilesMap {
		fullVarFileDstPath := filepath.Join(g.LocalPath, varFileDst)
		if !g.FileExists(varFileDst) || updateRepo {
			if err := os.MkdirAll(filepath.Dir(fullVarFileDstPath), 0755); err != nil {
				return err
			}
			srcPath := filepath.Join(templateRepo.LocalPath, varFileSrc)
			if err := g.copyFile(srcPath, fullVarFileDstPath); err != nil {
				return err
			}
			changes = true
		} else {
			logger.Warn(fmt.Sprintf("%s file exists and will not overwrite it!", varFileDst), "git")
		}
	}

	dirty, err := g.IsDirty()
	if err != nil {
		return err
	}
	if dirty {
		changes = true
	}

	if changes {
		if err := g.AddAndCommit("idp-installer: auto-committing changes"); err != nil {
			return err
		}
		return g.Push()
	}

	logger.Info("No changes found in client tf repository", "git")
	return nil
}

func (g *GIT) copyFile(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	_, err = io.Copy(dstFile, srcFile)
	return err
}

func (g *GIT) fileExistsAbs(path string) bool {
	_, err := os.Stat(path)
	return !os.IsNotExist(err)
}

func (g *GIT) containsPlaceholders(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return strings.Contains(string(data), "{{")
}

func (g *GIT) renderTemplate(srcPath string, dstPath string, context map[string]interface{}) error {
	tpl, err := pongo2.FromFile(srcPath)
	if err != nil {
		return fmt.Errorf("failed to load template %s: %w", srcPath, err)
	}

	out, err := tpl.Execute(pongo2.Context(context))
	if err != nil {
		return fmt.Errorf("failed to execute template %s: %w", srcPath, err)
	}

	if err := os.MkdirAll(filepath.Dir(dstPath), 0755); err != nil {
		return fmt.Errorf("failed to create directory for %s: %w", dstPath, err)
	}

	return os.WriteFile(dstPath, []byte(out), 0644)
}

