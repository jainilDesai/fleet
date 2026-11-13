# Changelog

## 0.3.1

- The top bar fits at every window width. Below 1536px it hides the repo path and the
  "Plan wall" label, so the project name always shows (hover it for the repo).
- The README shows the office, an agent's drawer, Action items and the Team settings.

## 0.3.0

Fleet is now an office for a team of Claude Code agents, built on
[JSM HQ](https://github.com/jsmastery-pro/jsm-hq) by JavaScript Mastery (MIT).

- **Pixel office.** HQ's office UI replaces the old dashboard. Each agent sits at a desk and
  shows what it's doing; tasks move on the plan wall; messages are rendered as Markdown.
- **A CTO-led team.** You talk to the CTO, which plans and assigns work to a Planner,
  Implementer, QA, Reviewer and Deployer. Agents start the first time they're needed.
- **Real sessions.** Every agent is `claude` in tmux, in its own git worktree under
  `~/.fleet/projects/<repo>/`. **Open in iTerm** attaches to it.
- **Actions.** Questions, plan and deploy approvals, and Claude Code permission prompts
  (Allow/Deny) in one list. A production deploy is labelled so it never looks routine.
- **Make it your flow.** Every agent, the CTO included, has an editable role you can load from
  a file, and its own skills you can paste or upload. `~/.fleet/roles/<role>.md` sets your
  own defaults for every new repo.
- **Pull requests.** With `gh`, Fleet follows the team's PRs: review comments go to the
  author, passed reviews to the CTO, merges close the task. PRs from forks are ignored.
- **Breaking:** Fleet now needs tmux and works on one git repo per run: the current folder
  or `--repo <path>`. It exits with a clear message outside a git repo.
- **Breaking:** the Agents, History, Usage, MCP and Plugins pages are gone. macOS
  notification banners still work, and history is still recorded.
- **Auto-start** now remembers the repo. If you set it up before 0.3.0, run
  `fleet --autostart` again from your repo, or the background copy can't start.

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
