# Changelog

## 0.11.2

- **Finished boards ask to be closed.** When every task on a board is done, Action items asks
  once: Approve marks it Done (its agents save a handoff and stop; a separate team then shuts
  down). Asked again only after the board gets a new task. Boards already finished are asked about
  when their Fleet starts.
- **Restart to apply.** Change an agent's model or permission mode (or the project's) while it
  runs, and its drawer says so, with a button that restarts it with a handoff.
- **A banner for the folder-trust prompt.** A new agent waiting on Claude Code's "trust this
  folder" prompt now tells you, not only on Fleet's page; nothing reaches it until you answer.
- **One GitHub poll per repo.** Teams on the same repo share one PR fetch (cached in
  ~/.fleet/github) instead of each spending the API budget; a rate limit pauses them all.
- **Fewer stray Enters.** Fleet pressed Enter a second time whenever Claude Code confirmed a
  message late, which could send text you were typing. Now only while Fleet's message is still
  unsent at the prompt.

## 0.11.1

- **The home page shows only what runs.** A team's card shows while its Fleet runs; a stopped
  team's boards are in its project's Boards → History (Open, Revive). Projects always show.
- **Teams named before 0.11 get their own name back.** New work on a team's page used to name the
  new team after that team, cut at 80 characters, so they all read the same. History shows each
  as "<project> · <its board>", and a team's name is corrected when it starts.

## 0.11.0

- **Every agent can message you.** `send_message` takes "you", so an Implementer or QA can tell
  you something on its own; it shows in that agent's chat. Before, only the CTO's answers, or an
  answer to something you asked, reached you; the rest stayed in the agent's terminal.
- **Notifications.** A macOS banner (FleetView's, same on/off setting) when an agent messages
  you, asks a question, wants an approval or a permission. Clicking it opens that team's page.
- **Shift+Enter for a new line** in every message box: agent chat, New work, Action item notes
  and your own answers. Enter sends; the box grows as you write.
- **Skip permission prompts.** A new mode, for the whole project (when you create the team, or
  in Settings → Project) or per agent (Settings → Team, where "Project's: …" is the default). The
  Deployer keeps asking first. The CTO can make an agent ask more with `set_permission_mode`;
  asking less waits for your Approve in Action items.
- **One History per project.** Boards → History shows the done boards of every team on the
  project, not only this page's, with **Open** for a team that's running and **Revive** to start
  New work on a fresh team from a board's brief and what came of it.
- **Teams stay under the project.** New work on a team's page makes a team of the project, named
  "<project> · <title>", instead of a team of that team. Teams made the old way are found too.
- **A finished team shuts down.** When a team's last board is Done, its agents and its Fleet
  stop: no port taken, no GitHub polling. Start it on the home page and its last board reopens.
- **Images.** Paste a screenshot into an agent's message box or into New work: Fleet saves it in
  the project's own folder and the agent opens it. Agents can send you screenshots, shown in the
  chat. Only real PNG, JPEG, WebP and GIF files, up to 10 MB.
- **Fixes:** GitHub errors in the log show the real error instead of the echoed query.

## 0.10.1

- **Every answer to you shows in the agent's chat.** A question you type straight into an agent's
  terminal now shows in its chat in Fleet, with the answer. And when you message a busy agent and
  a teammate's message arrives at the same moment, its answer to you is posted before it moves on,
  instead of being lost.
- **Agents' questions get proper selectors.** Each question shows its options as rows to pick:
  one choice (radio) or any (checkboxes), each with its description, plus **Something else** to
  write your own answer. It says how many are answered, sends once all are, and questions sit at
  the top of Action items. A question asked before 0.10 shows its options instead of JSON.

## 0.10.0

- **New work gets a team of its own.** By default, New work starts a second Fleet on the same
  repo: a new CTO on its own page and port, with only that work's tasks and its own card on the
  home page. It starts with the CTO alone (add agents up front if you like), asks you for each
  agent it needs, and removes them with the new `remove_agent` once they're done. **This team**
  keeps the old flow.
- **Answers to agents' questions reach them.** An agent's multiple-choice question
  (AskUserQuestion) shows in Action items with its options, and your answer goes straight back.
  A note you write with **Allow** now reaches the agent too.
- **Long messages arrive whole.** Messages are delivered as one paste, so long and multi-line
  ones are no longer cut off or split; a message is never typed twice.
- **Tasks stay right.** `set_my_status` names its task, so a result can't land on another one.
  Notes keep up to 2,000 characters and messages 8,000, and agents are told when theirs was
  trimmed. A PR an agent reported stays on its task, and a PR closed without merging tells the
  CTO its task is still open.
- **A quieter CTO chat.** It shows your conversation; its turns for teammates and Fleet notices
  are one click away under **Team activity**. Every substantial reply in a turn is kept.
- **Agents can run the tests.** Each worktree gets your installed `node_modules` as a
  copy-on-write clone (no extra disk) and copies of your gitignored env files.
- **Done asks first** when a board has agents mid-turn, uncommitted work or unfinished tasks,
  and **Reopen** restarts the agents Done stopped.
- **Fixes:** Haiku 5's context is 1M, not 200k (it showed 82% on a fresh session and would have
  refreshed after every turn); the CTO's session-start context stays under Claude Code's limit;
  log lines have timestamps; GitHub errors are logged in full; history keeps 500 messages.

## 0.9.0

- **Refresh with a handoff.** ⟳ in every agent's chat, the CTO's included, replaces its
  session with a fresh one that starts from a handoff Fleet writes from its own records: tasks,
  branch, uncommitted files, last commits, recent messages, last reply. Fleet does it by itself
  once an agent's context passes 60% (Settings → Workflow → Refresh agents at). Same agent, same
  folder and tasks. The chat header shows context use; a History tab lists the handoffs.
- **Done boards move to Boards → History.** Marking a board Done saves its agents' handoffs and
  a summary, stops them, removes the agents New work added for it, and deletes their worktrees.
  Uncommitted work is never deleted without asking: the CTO asks you in Action items. **Reopen**
  in History makes the board active again and gives the CTO its summary.

## 0.8.1

- **A fresh CTO for each New work.** New work restarts an idle CTO in a clean session (a
  checkbox, on by default), so a long history can't crowd it. Every CTO session, and every
  context compaction, starts with Fleet's plan: open boards, unfinished tasks and owners, the
  team and open Action items. A busy CTO keeps its session.

## 0.8.0

- **+ New project on the home page.** Start Fleet on any folder without a terminal: type the
  path (with suggestions from folders you've used Claude Code in) or press **Choose…** for the
  folder picker, and add an optional first task. A folder that isn't a git repo yet, or has no
  commit, can be set up for you when you tick **Make it a git repo**. Fleet opens the project;
  after the team setup, **New work** opens with your first task filled in.
- **New work is easier to follow.** The plan wall shows the newest active board, Boards opens on
  the newest board, and a started board has a **CTO's replies** button.

## 0.7.0

- **New work.** Boards → **+ New work** (or **New work** on a running project on the home page)
  sends a prompt to the CTO on a board of its own. Choose **Investigation only** (report back, no
  code changes or PRs), and **Current team** or **Add agents for this work**: up to 3 per role
  and 6 in all, each in its own new worktree, so it runs next to the current work. **Send to the
  CTO** now, or **Save for later** and press **Start now** on the board whenever you want.
- **The CTO can ask for agents.** New Team MCP tool `add_agent` (lead only): the request shows in
  Action items as **Approve new agent: …**; Approve adds the agent in its own worktree and tells
  the CTO its id, Reject adds nobody.
- **Clearer plan wall picker.** The top bar picker reads **Wall shows** / **Showing: …**: it only
  changes which board the office wall shows, and gives nobody work.

## 0.6.1

- **The logo goes home.** The Fleet logo and name in the top bar link to the home page
  (localhost:7788); the separate **Home** button is gone, which gives the project name more room.
  The **⇄** switcher stays.
- **Stop team moved to Settings → Team.** The top bar no longer has **Stop team**; the Team tab
  ends with a **Stop team…** button that opens the same dialog (**Stop agents**, **Stop agents and
  quit Fleet**, **Cancel**). It's disabled, with a note, while no agent runs.
- **Auto-stop idle agents.** New in Settings → Workflow: **Stop idle agents after** 1, 3 (the
  default) or 7 days, or Never. Every 15 minutes Fleet stops a running agent that's been idle that
  long, with no open Action item, no question waiting, no queued message and no unsent text at its
  prompt, and says so in the activity feed. An idle agent doesn't act on its own, but it holds
  memory, and waking it days later re-sends a long, uncached context. Start team or a new task
  brings it back as a fresh session. Each agent's last activity is now saved in the project's
  `history.json`, so the idle clock survives a Fleet restart.

## 0.6.0

- **Stop team.** While any agent runs, the top bar shows **Stop team**. It lists the running
  agents and offers **Stop agents** (ends their Claude Code sessions, all at once; work,
  worktrees, branches, plans and the team are kept) or **Stop agents and quit Fleet**, which
  then exits Fleet with code 0 so the login item doesn't bring it back until the next login or
  `fleet --start`. The page then says Fleet has stopped and how to start it again.
- **Role picker.** The Role field in Settings → Team, Add an agent and Set up your team is a
  real menu now: the built-in roles, the roles you saved, and **New role…** to name your own.
  It used to be a text box with suggestions that only ever showed the role already typed in.
  Picking a role gives the agent that role's ROLE.md, skills and permission mode, and asks
  before replacing a ROLE.md or skills you changed.
- **Saved roles.** **Save as my role** (Settings → Team → More) saves an agent's ROLE.md and
  skills to `~/.fleet/roles/<role>.md` and `<role>.skills/`. On any project, the next agent that
  gets that role starts with them. **Delete my role** and **Reset to built-in** remove only that
  role's files. Existing `~/.fleet/roles/*.md` files keep working, and now show in the menu.
- **Docs:** how skills reach agents: `~/.claude/skills` for everyone, a role's skills for every
  agent with that role, and per-agent skills for one agent.
- **Docs:** a Stopping section covering the drawer's Stop, Stop team, quitting, `fleet --stop`
  (`--all`) and Ctrl-C.
- **Home page.** `fleet home` (or `fleet open`, or `fleet` outside a git repo) opens Fleet's
  home page at `http://localhost:7788`: every project Fleet knows, running or stopped, its URL,
  agents running, what needs you, open PRs, and API-equivalent cost for today, 7 days and all
  time. **Open**, **Start** and **Stop** per project; **Forget** for a project whose repo is
  gone. It runs in the background, starts whenever `fleet` runs in a repo, and starts at login
  once any repo does (`com.jainildesai.fleet.home`, `fleet-home.service`; `fleet home
  --autostart` / `--no-autostart`). Each project's top bar links back to it with **Home**.
- **Install as an app.** The home page has a web app manifest and pixel icons: install it from
  Chrome or Edge, or Safari's File → Add to Dock.
- **Projects start at port 7789** (7788 is the home page's). A login item pinned to 7788 by an
  earlier version moves to the next free port the first time the home page starts, and says so.
  Its agents keep running; until they restart, the home page passes their hooks and Team MCP
  calls on to their project.
- **A repo folder named `home`** now gets the project name `home-<hash>`: `home` belongs to the
  home page's login item. A team set up earlier under `~/.fleet/projects/home` isn't picked up
  again; move it to the new folder name, or start the team again.
- **Linux:** the systemd service now has `KillMode=process`, so stopping or restarting Fleet
  leaves the agents' tmux sessions running, as on macOS.

## 0.5.0

- **Linux.** Fleet runs on Linux: `sudo apt install tmux`, then the same `npm install -g` and
  `fleet`. The browser opens with `xdg-open`. **Open in terminal** uses the first installed of
  `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `kitty`, `alacritty`,
  `wezterm` and `xterm`. Banners use `notify-send` when it's installed (no click action).
- **Windows through WSL.** Fleet runs inside WSL. The browser opens with `wslview` or
  `explorer.exe`, and **Open in terminal** opens a Windows Terminal tab in your distro. No
  banners on WSL. On native Windows, `fleet` now installs, and says how to set up WSL
  instead of running (`--version` and `--help` still work).
- **Start at login on Linux and WSL** is a systemd user service,
  `~/.config/systemd/user/fleet-<project>.service`, with the same port, log and
  restart-on-crash as on macOS. `--stop`, `--start`, `--no-autostart` and `--all` work the same.
  `loginctl enable-linger` starts it at boot. Without systemd (WSL's default), `--autostart`
  says how to turn it on in `/etc/wsl.conf`.
- **Setup checks** show which terminal Open in terminal will use on each platform, and give
  apt fixes (with links for dnf and pacman) instead of brew off macOS. When Fleet can't open a
  terminal, the help under the `tmux attach` command fits your platform: the Automation
  permission is only mentioned on macOS.
- The older session board's launch and focus buttons say they're macOS-only off macOS,
  instead of calling AppleScript.
- macOS is unchanged.

## 0.4.0

- **Several projects at once.** Run `fleet` in each repo. Without `--port`, a taken 7788 means
  the next free port (Fleet says which); `fleet` in a repo that already has a copy opens that
  one. `fleet --list` shows every running copy, and the top bar has a **⇄** switcher to the
  others. Running copies are kept in `~/.fleet/running/`.
- **Unique projects.** A project's home records its repo root (`repo-root`). A second repo with
  the same folder name gets `<name>-<hash>` instead of sharing the first one's team. Existing
  projects keep their name, tmux sessions and worktrees.
- **Two teams on one repo.** New agent worktrees use `fleet/<project>/<agent>` branches, so two
  checkouts of the same repo don't fight over `fleet/<agent>`. Existing worktrees and branches
  keep working. PR sync ignores other projects' `fleet/…` branches, and on a shared repo only
  claims a task's PR once the agent reported it.
- **Start at login per repo.** `fleet --autostart` writes `com.jainildesai.fleet.<project>`
  with its own port and log (`~/.fleet/fleet-<project>.log`); the older `com.jainildesai.fleet`
  item is recognised as its repo's and replaced on the same port. `--stop`, `--start` and
  `--no-autostart` act on this repo only; `--all` for every one. `--autostart` refuses to run
  from the npx cache. `--start` checks launchd's real state, so a copy that keeps exiting is
  restarted and its last exit code shown, not reported as running. A background copy whose repo
  already has a Fleet exits cleanly instead of being restarted forever. The stale-install
  warning also checks Fleet's own path.
- **One set of banners.** Only one copy watches every Claude session (banners,
  `events.jsonl`, `history.json`); another takes over when it stops.
- **Requirements in the UI.** The welcome screen and Settings → Project show each check
  (tmux, Claude Code, Claude Code sign-in, `gh`, GitHub remote, terminal) with ✓/✗, its fix
  command and **Check again**.
- **No GitHub remote or `gh`:** a new team starts with PR review off, and agents are told
  there are no PRs: commit on a branch, don't push.
- **Trust folder.** Claude Code's first-start folder-trust prompt can be answered from Action
  items or the agent's drawer (worktrees Fleet made only). Fleet presses Enter only once
  "Yes, I trust this folder" is highlighted.
- **Sign-in.** Fleet checks `claude auth status`, and notices Claude Code's login screen in an
  agent's terminal.
- **Terminal.** "Open in iTerm" is now **Open in terminal**: iTerm if installed, else
  Terminal.app (which failed before: zsh expanded the `=session` target). If macOS blocks it,
  Fleet shows the `tmux attach` command with Copy and how to allow it.
- **CLI.** `fleet --version`; a bad or missing `--port` value and unknown flags stop with a
  clear message; a repo with no commits stops with "Make a first commit".
- No `~/.claude` yet (Claude Code never run) no longer logs an error every 1.5 seconds.
- A permission prompt counts once in Action items, not also as "asking in its terminal".
- The "Needs input" badge stays readable (only its dot blinks), the activity panel is opaque,
  and the team list is hidden behind the welcome screen.
- README: a First run walkthrough, the permission-mode note, the terminal, and the `ETARGET` fix.

## 0.3.2

- Plan and deploy approvals now have Approve / Reject buttons. Rejecting tells the agent to
  stop, not to find another way.

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
