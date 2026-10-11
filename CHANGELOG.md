# Changelog

## 0.2.2

- `fleet --stop` also stops a copy run with `npx` or installed in a project folder
  (`node_modules/.bin/fleet`). 0.2.1 only found global installs and the background copy.

## 0.2.1

- `fleet --stop` stops Fleet for now, including the background copy, which otherwise macOS
  would restart. Auto-start stays on, so Fleet comes back at the next login.
- `fleet --start` starts the background copy again right away.

## 0.2.0

- **Start at login:** `fleet --autostart` sets Fleet up to run in the background from login
  (no browser tab, restarted if it crashes, logged to `~/.fleet/fleet.log`), and
  `fleet --no-autostart` turns it off. Fleet warns when the login item points at a Node
  version that no longer exists.
- `fleet --help` lists the options.

## 0.1.2

- The README opens with a short demo: agents updating live, a notification arriving, a
  session's subagents, and a History search. No changes to Fleet itself.

## 0.1.1

- Session names stay whole on narrow cards; the branch shortens instead. With the detail
  panel open, names like "checkout" were cut to "checko…".
- The npm page links to the new website, https://fleet.jainildesai.com.
- The README's session screenshot now shows the session panel it describes.

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
