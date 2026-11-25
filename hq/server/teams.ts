// Separate teams: New work can run on a team of its own, a second Fleet on the same repo
// (`fleet --project <slug>`), with its own CTO, port, page and plan, and its own card on the home page.
// Its project home is seeded here (the lead copied from this project, one board with the brief), then
// that Fleet is started in the background and starts the work by itself (brief.autoStart).

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Board, CrewSlot, HqConfig, PastBoard } from "../src/data/types";
import type { Hub } from "./hub";
import { projectHome, slugify, validSlug } from "./paths";
import { saveConfig, savePlan } from "./store";
import { running, urlOf } from "../../src/registry.js";

const projectsDir = () => join(homedir(), ".fleet", "projects");

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};
const configOf = (slug: string) => readJson<HqConfig>(join(projectsDir(), slug, "config.json"));

/** The project a team belongs to: `parent` followed up (before 0.11, New work on a team's page made a team of that team). */
export function rootSlug(slug: string): string {
  const seen = new Set<string>();
  for (let parent = configOf(slug)?.project?.parent; parent && !seen.has(parent); parent = configOf(slug)?.project?.parent) {
    seen.add(slug);
    slug = parent;
  }
  return slug;
}

/**
 * A team's name: its project's name · its first board's title. Teams made before 0.11 from another team's page
 * took that team's name instead (cut at 80 characters, so they all read the same); this is what they should be.
 */
export function teamName(slug: string): string {
  const root = rootSlug(slug);
  const own = configOf(slug)?.project?.name ?? slug;
  const title = readJson<{ boards?: Board[] }>(join(projectsDir(), slug, "plan.json"))?.boards?.[0]?.title;
  return root === slug || !title ? own : `${configOf(root)?.project?.name ?? root} · ${title}`.slice(0, 80);
}

/**
 * Every board of a project and its teams, for History: this Fleet's own done boards (`own`, from memory),
 * and every board of the project's other teams, read from their plan.json. Newest first.
 */
export function projectHistory(slug: string, ownBoards: Board[]): PastBoard[] {
  const root = rootSlug(slug);
  let slugs: string[] = [];
  try {
    slugs = readdirSync(projectsDir()).filter((s) => s !== slug && rootSlug(s) === root);
  } catch {}
  const urls = new Map((running() as { slug: string }[]).map((e) => [e.slug, urlOf(e)]));
  const past = [
    ...ownBoards.filter((b) => b.status === "done").map((board) => ({ team: slug, teamName: teamName(slug), board, own: true })),
    ...slugs.flatMap((s) =>
      (readJson<{ boards?: Board[] }>(join(projectsDir(), s, "plan.json"))?.boards ?? []).map((board) => ({ team: s, teamName: teamName(s), board, own: false })),
    ),
  ];
  return past
    .map((p) => ({ ...p, url: p.own ? null : (urls.get(p.team) ?? null) }))
    .sort((a, b) => (b.board.doneAt ?? b.board.brief?.startedAt ?? "").localeCompare(a.board.doneAt ?? a.board.brief?.startedAt ?? ""));
}

/** A free slug for a team on this project: <project>-<title>, numbered if taken. */
export function teamSlug(parent: string, title: string): string {
  const base = `${parent}-${slugify(title)}`.slice(0, 50).replace(/-+$/, "");
  let slug = validSlug(base) ? base : `${parent}-team`.slice(0, 50);
  for (let i = 2; existsSync(join(projectsDir(), slug)); i++) slug = `${base.slice(0, 46)}-${i}`;
  return slug;
}

export interface TeamBrief {
  title: string;
  prompt: string;
  investigate: boolean;
  crew: CrewSlot[];
}

/**
 * Writes the new team's project home: repo-root, a config with this project's lead (role text, model,
 * skills) as its only agent and this project's workflow, and a plan with one board holding the brief.
 */
export function seedTeam(hub: Hub, slug: string, brief: TeamBrief, root = hub.slug) {
  const home = projectHome(slug);
  writeFileSync(join(home, "repo-root"), hub.repo.root + "\n", { flag: "wx" });
  const main = hub.snap.config;
  const lead = main.team.find((a) => a.isLead);
  if (!lead) throw new Error("This project has no lead to copy.");
  const config: HqConfig = {
    ...structuredClone(main),
    // Named after, and a child of, the project itself, even when New work was started on another team's page.
    project: { ...structuredClone(main.project), id: slug, name: `${configOf(root)?.project?.name ?? main.project.name} · ${brief.title}`.slice(0, 80), parent: root, exportPlan: false },
    team: [{ ...structuredClone(lead), workspacePath: null }],
  };
  saveConfig(home, config);
  const id = brief.title.split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "W";
  savePlan(home, {
    boards: [{ id, title: brief.title, status: "planned", order: 0, brief: { prompt: brief.prompt, investigate: brief.investigate, crew: brief.crew, startedAt: null, freshLead: false, autoStart: true } }],
    tasks: [],
  });
}

/** Starts the team's Fleet in the background, logging to ~/.fleet/fleet-<slug>.log. */
export function startTeam(slug: string, root: string) {
  const script = fileURLToPath(new URL("../bin/fleet.js", import.meta.url));
  mkdirSync(join(homedir(), ".fleet"), { recursive: true });
  const fd = openSync(join(homedir(), ".fleet", `fleet-${slug}.log`), "a");
  try {
    spawn(process.execPath, [script, "--repo", root, "--project", slug, "--no-open"], { detached: true, stdio: ["ignore", fd, fd], env: process.env }).unref();
  } finally {
    closeSync(fd);
  }
}

/** The team's URL once its Fleet serves, or null after `ms`. */
export async function waitForTeam(slug: string, ms = 30_000): Promise<string | null> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 500))) {
    const e = (running() as { slug: string; port: number }[]).find((x) => x.slug === slug);
    if (e) return urlOf(e);
  }
  return null;
}
