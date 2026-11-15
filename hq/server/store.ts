// Persistence in the project's home (~/.fleet/projects/<slug>/, never in the repo):
// config.json (team + workflow) and plan.json (boards + tasks).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, Board, HqConfig, SandboxSettings, Task } from "../src/data/types";
import { DEFAULT_ROLES, LEAD_NAME } from "../src/data/names";
import { agentPalette } from "../src/theme/tokens";
import { slugify } from "./paths";
import { rolePreset } from "./roles";
import type { RepoInfo } from "./repo";

export interface PlanFile {
  boards: Board[];
  tasks: Task[];
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

/** Atomic write so a crash never leaves half a file. */
function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Kept only because the shared AgentConfig type still has it; Fleet runs no sandboxes. */
export const defaultSandbox = (): SandboxSettings => ({
  resources: { cpus: null, memoryGb: null },
  allow: [],
  deny: [],
});

export function newAgent(id: string, name: string, role: string, color: string, isLead: boolean): AgentConfig {
  const preset = rolePreset(name, role, isLead);
  return {
    id,
    name,
    role,
    isLead,
    cli: "claude",
    model: "", // the CLI's default; users can pick with /model or "Start with model"
    mode: "local",
    color,
    skills: [],
    roleMd: preset.roleMd,
    ...(preset.permissionMode ? { permissionMode: preset.permissionMode } : {}),
    ...(preset.skillFiles ? { skillFiles: preset.skillFiles } : {}),
    sandbox: defaultSandbox(),
    workspacePath: null,
    mcp: [],
  };
}

function defaultConfig(repo: RepoInfo, port: number): HqConfig {
  return {
    project: { id: slugify(repo.name), name: repo.name, repo: repo.github ?? repo.name, path: repo.root, hqPort: port },
    team: [
      newAgent(slugify(LEAD_NAME), LEAD_NAME, "Lead", agentPalette[0], true),
      ...DEFAULT_ROLES.map((r, i) => newAgent(slugify(r), r, r, agentPalette[(i + 1) % agentPalette.length], false)),
    ],
    workflow: {
      review: { enabled: true, tool: repo.hasCodeRabbit ? "coderabbit" : "human", command: "" },
      merge: { by: "human" },
      deploy: { enabled: repo.hasInsta, tool: "instacloud", command: "", perAgentEnvironments: repo.hasInsta },
      stopIdleAfterDays: 3,
    },
  };
}

/** `isNew`: no config yet — the welcome screen fills it in, then it's saved. */
export function loadConfig(home: string, repo: RepoInfo, port: number): { config: HqConfig; isNew: boolean } {
  const file = join(home, "config.json");
  const found = readJson<HqConfig>(file);
  if (found) {
    // Older files may miss newer fields.
    for (const a of found.team) {
      a.workspacePath ??= null;
      a.mcp ??= [];
      a.cli ??= "claude";
      a.sandbox.resources ??= { cpus: null, memoryGb: null };
      // Phase D: policy level, proxy and secret names moved to sbx itself.
      const old = a.sandbox as unknown as Record<string, unknown>;
      delete old.policy;
      delete old.proxy;
      delete old.secrets;
    }
    found.workflow.stopIdleAfterDays ??= 3;
    // Configs from before project.id: their resources are named after the current name.
    // Slugified again in case the file was edited by hand: it ends up in paths and sandbox names.
    found.project.id = slugify(found.project.id ?? found.project.name);
    found.project.path = repo.root;
    return { config: found, isNew: false };
  }
  return { config: defaultConfig(repo, port), isNew: true };
}

export function saveConfig(home: string, cfg: HqConfig) {
  writeJson(join(home, "config.json"), cfg);
}

export function loadPlan(home: string): PlanFile {
  return readJson<PlanFile>(join(home, "plan.json")) ?? { boards: [{ id: "B1", title: "Backlog", status: "active", order: 0 }], tasks: [] };
}

export function savePlan(home: string, plan: PlanFile) {
  writeJson(join(home, "plan.json"), plan);
}
