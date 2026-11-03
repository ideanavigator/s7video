# Source control

T3 Code works with local Git repositories. This build ships no code-hosting integrations
(GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe), so cloning, publishing, and pull
requests through a host are not available.

## Review turn changes

A turn's changed files and diff show only the turn's own work. When a turn pulls, merges, or
rebases, the files Git brought in are left out. A file stays in the list when the turn edited it,
committed it, or fixed a conflict in it. Use the branch comparison to review everything that changed
against your base branch. Restore still returns the complete saved workspace.

On web and desktop, open the Diff pane source picker and choose **Commits** to review one local
commit at a time. The list shows the newest 100 commits in the branch comparison. A merge commit
shows its changes against its first parent.
