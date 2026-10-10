# Changelog

## 0.1.0

First public release, on npm as `@jainil_desai/fleet`.

- **Agents:** every live Claude Code session on the Mac, grouped by repo, with status, model,
  branch, current tool call, cost including subagents, and context use. Subagent trees and
  workflow phases in each session's panel.
- **History:** a record of every session (title, project, branch, model, cost, prompts, files
  edited) kept in `~/.fleet/history.json` after Claude Code deletes the transcript, with search
  and on-demand summaries.
- **Notifications:** inbox, tab badge and macOS banners when an agent needs you, finishes, or a
  subagent or workflow ends. Banners open the session's terminal tab when clicked if
  `terminal-notifier` is installed.
- **New agent:** launches `claude` in Terminal or iTerm through your login shell, with model,
  effort, permission mode, name, first prompt and optional worktree.
- **Usage, MCP servers, plugins & skills** pages, and plan limits through the statusline.
- Warns on the Agents page when Claude Code's transcript format isn't recognized.
- Workflow `journal.jsonl` files are no longer shown or counted as agents.
