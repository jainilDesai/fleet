// The default team's roles: what each one does. Generic on purpose: it names no skills or
// services a user may not have. This becomes the agent's ROLE.md text (editable in Settings → Team).
// Your own defaults: ~/.fleet/roles/<role>.md (cto.md for the lead) replaces the text below for new agents,
// and the skills in ~/.fleet/roles/<role>.skills/<name>/SKILL.md are given to them too.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_ROLES, genericRoleMd, ROLE_NAME, roleKey } from "../src/data/names";
import type { PermissionMode, RoleInfo, SaveRoleInput, SkillFile } from "../src/data/types";
import { cleanSkills, skillText } from "./agentFiles";

export interface RolePreset {
  roleMd: string;
  /** Claude Code permission mode to start in; unset = your own default. */
  permissionMode?: PermissionMode;
  /** Skills saved with your own version of the role. */
  skillFiles?: SkillFile[];
}

const LEAD = `You are the CTO. The user talks only to you; everyone else works for you.

How work flows (adapt it to the request, skip steps that don't apply):
1. Planner: turns the request into a plan (files, reuse, risks) following the repo's own rules.
2. You: send the plan to the user for approval with ask_user ("Approve plan: <title>", the plan in details, approval: true). Wait for Approve; Reject = don't build it.
3. Implementer: builds the approved plan on its own branch and commits.
4. QA: tests that branch. Reviewer: reviews the diff for bugs and simplicity. Both report back to you.
5. Deployer: only when the user asks for a deploy. It asks the user to approve each deploy itself.

You never write app code and never deploy. Pass each agent everything it needs in the task description:
the goal, the files, the branch to work on, what "done" means. When work finishes, is blocked, or needs a
decision, tell the user in plain words: what happened, what's next, what you need from them.
When the work needs more hands (two features in parallel, a second reviewer), ask for agents with add_agent;
the user approves each one.`;

const PRESETS: Record<string, RolePreset> = {
  planner: {
    roleMd: `You are the Planner. You turn a request into an implementation plan; you don't change code.

- Read the repo's own instructions first (CLAUDE.md, .claude/ rules) and follow any plan template they define.
- Find what already exists and reuse it. Name exact files.
- If you have a skill for planning or for weighing a decision, use it.
- Put the plan in your task (update via set_my_status with a note, or send it to the lead with send_message) and set_my_status done.`,
  },
  implementer: {
    roleMd: `You are the Implementer. You build what the lead assigns, on your own branch.

- Only start code once your task says the user approved the plan. The repo may require approval before coding: the lead's assignment with an approved plan is that approval. Without one, send the plan to the lead and wait.
- Smallest change that solves it; match the surrounding code; no drive-by refactors.
- Before finishing, explain in your last reply what you changed and why, in 2-4 bullets.
- Commit following the repo's commit-message conventions. Push only if the task says so. Never deploy.`,
  },
  qa: {
    roleMd: `You are QA. You test a branch the lead names, and report pass/fail with evidence; you don't fix code.

- Check out the branch in your worktree: \`git fetch\` if it's remote, then \`git checkout --detach <branch>\` (it may be checked out in another agent's worktree).
- Your worktree has no dependencies installed: run the install the repo uses before running anything.
- Run the repo's tests and checks. If you have a skill for testing this app (for example in a browser), use it. Never test against production unless the task says so.
- Report what you ran, what passed, what failed (exact output), and anything you couldn't test.`,
  },
  reviewer: {
    roleMd: `You are the Reviewer. You review a branch's diff for correctness and simplicity; you don't change code.

- Check out the branch detached (\`git checkout --detach <branch>\`) and diff it against its base.
- Look for bugs, missed edge cases, security problems and needless complexity. If you have a code-review skill, use it.
- Report findings ranked by severity with file:line, and say clearly whether it's ready to ship.`,
  },
  deployer: {
    permissionMode: "default",
    roleMd: `You are the Deployer. You deploy only when the lead says the user asked for a deploy.

- Use the repo's documented deploy process (README, CLAUDE.md, a deploy skill or script); never improvise a deploy command.
- Before every deploy, call ask_user with title "Approve deploy to <environment>: <branch>" and what will be deployed in details, waiting=true, approval=true. Deploy only after the user approves. Rejected = don't deploy, by any means.
- If a permission prompt or a guard asks for approval, wait for the user. Never try to get around a guard or a denial.
- Report the result and any link to the lead.`,
  },
};

const rolesDir = () => join(homedir(), ".fleet", "roles");

/** First line of a role you named in Fleet: its display name. Plain .md files without it still work. */
const NAME_LINE = /^<!-- fleet-role: (.{1,40}) -->\n?/;
/** Same cap as ROLE.md in Settings → Team. */
const ROLE_MD_MAX = 8000;

/** Your own version of a role, from ~/.fleet/roles/<key>.md and <key>.skills/, if you made one. */
function ownRole(key: string): { name?: string; roleMd: string; skillFiles: SkillFile[] } | null {
  if (!key) return null;
  let text: string;
  try {
    text = readFileSync(join(rolesDir(), `${key}.md`), "utf8");
  } catch {
    return null;
  }
  const roleMd = text.replace(NAME_LINE, "").trim();
  if (!roleMd) return null;
  const dir = join(rolesDir(), `${key}.skills`);
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {}
  const skillFiles = cleanSkills(
    names.map((name) => {
      try {
        return { name, content: readFileSync(join(dir, name, "SKILL.md"), "utf8") };
      } catch {
        return null;
      }
    }),
  );
  return { name: text.match(NAME_LINE)?.[1]?.trim(), roleMd, skillFiles };
}

export function rolePreset(name: string, role: string, isLead: boolean): RolePreset {
  const key = roleKey(role, isLead);
  const preset = isLead ? { roleMd: LEAD } : (PRESETS[key] ?? { roleMd: genericRoleMd(name, role) });
  const own = ownRole(key);
  return own ? { ...preset, roleMd: own.roleMd, ...(own.skillFiles.length ? { skillFiles: own.skillFiles } : {}) } : preset;
}

/** The role picker's list: the built-in roles (the lead's included), then the roles you saved. */
export function listRoles(): RoleInfo[] {
  const info = (key: string, name: string, builtIn: boolean, lead = false): RoleInfo => {
    const own = ownRole(key);
    const builtInMd = lead ? LEAD : (PRESETS[key]?.roleMd ?? null);
    const permissionMode = PRESETS[key]?.permissionMode;
    return {
      key,
      name: builtIn ? name : (own?.name ?? name),
      builtIn,
      ...(lead ? { lead } : {}),
      saved: !!own,
      roleMd: own?.roleMd ?? builtInMd,
      ...(builtIn ? { builtInMd } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      skillFiles: own?.skillFiles ?? [],
    };
  };
  const roles = [info("cto", "Lead", true, true), ...BUILT_IN_ROLES.map((r) => info(roleKey(r), r, true))];
  let files: string[] = [];
  try {
    files = readdirSync(rolesDir()).sort();
  } catch {}
  for (const f of files) {
    const key = f.match(/^([a-z0-9-]+)\.md$/)?.[1];
    if (!key || roles.some((r) => r.key === key)) continue;
    const role = info(key, key[0].toUpperCase() + key.slice(1), false);
    if (role.saved) roles.push(role);
  }
  return roles;
}

/** "Save as my role": writes ~/.fleet/roles/<key>.md and replaces <key>.skills/. Returns the role's name. */
export function saveRole(input: SaveRoleInput): string {
  const lead = input?.lead === true;
  const name = lead ? "Lead" : typeof input?.name === "string" ? input.name.trim() : "";
  if (!ROLE_NAME.test(name)) throw new Error("A role name is 1 to 40 letters, digits, spaces, dashes or underscores.");
  const key = roleKey(name, lead);
  if (!lead && key === "cto") throw new Error('"cto" is the lead\'s role: save it from the lead instead.');
  const roleMd = typeof input.roleMd === "string" ? input.roleMd.trim() : "";
  if (!roleMd) throw new Error("Write the role's ROLE.md first.");
  if (roleMd.length > ROLE_MD_MAX) throw new Error(`A ROLE.md can be at most ${ROLE_MD_MAX} characters.`);
  const skills = cleanSkills(Array.isArray(input.skillFiles) ? input.skillFiles : []);
  const dir = rolesDir();
  mkdirSync(dir, { recursive: true });
  const builtIn = lead || BUILT_IN_ROLES.some((r) => roleKey(r) === key);
  // A built-in role's file stays plain text, as it always was; a new role keeps its display name.
  writeFileSync(join(dir, `${key}.md`), `${builtIn ? "" : `<!-- fleet-role: ${name} -->\n`}${roleMd}\n`);
  const skillsDir = join(dir, `${key}.skills`);
  rmSync(skillsDir, { recursive: true, force: true });
  for (const s of skills) {
    mkdirSync(join(skillsDir, s.name), { recursive: true });
    writeFileSync(join(skillsDir, s.name, "SKILL.md"), skillText(s.name, s.content));
  }
  return name;
}

/** "Delete my role" / "Reset to built-in": removes only that role's files in ~/.fleet/roles. */
export function deleteRole(key: string) {
  if (typeof key !== "string" || !/^[a-z0-9-]{1,40}$/.test(key)) throw new Error("That isn't a saved role.");
  rmSync(join(rolesDir(), `${key}.md`), { force: true });
  rmSync(join(rolesDir(), `${key}.skills`), { recursive: true, force: true });
}
