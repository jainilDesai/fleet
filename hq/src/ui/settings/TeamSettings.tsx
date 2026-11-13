import { useRef, useState } from "react";
import { nextAgentName } from "../../data/names";
import { SKILL_LIMITS, type AgentConfig, type PermissionMode, type SkillFile } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";
import { agentPalette } from "../../theme/tokens";
import { Field, Portrait, SectionTitle } from "../kit";
import { CommitInput } from "./controls";
import { RemoveAgentDialog } from "./RemoveAgentDialog";

const PERMISSION_LABEL: Record<PermissionMode | "", string> = {
  "": "Your Claude default",
  default: "Ask first (prompts in Action items)",
  acceptEdits: "Accept edits, ask for commands",
  auto: "Auto (classifier decides)",
  plan: "Plan only (read, no changes)",
};

export const ROLE_SUGGESTIONS = ["Planner", "Implementer", "QA", "Reviewer", "Deployer", "Developer"];

export function TeamSettings() {
  const team = useOffice((s) => s.snap?.config.team);
  const [open, setOpen] = useState<string | null>(null);
  const [removing, setRemoving] = useState<AgentConfig | null>(null);
  if (!team) return null;
  return (
    <div className="flex flex-col gap-5">
      <section>
        <SectionTitle>Team · {team.length} agents</SectionTitle>
        <p className="mb-3 text-[14px] text-muted">
          Changes to model, folder, role or skills apply the next time the agent starts. One lead plans and assigns work. Every other agent gets its own desk and git worktree, and starts when the lead first gives it work. The office grows as you add agents.
        </p>
        <p className="mb-3 text-[14px] text-muted">
          Make it your flow: open <b>More</b> on any agent, the CTO included, to rewrite its role or load one from a file, and attach skills. For your own defaults on every new repo, save role texts as <code>~/.fleet/roles/&lt;role&gt;.md</code> (<code>cto.md</code>, <code>planner.md</code>, <code>qa.md</code>…).
        </p>
        <div className="flex flex-col gap-2">
          {team.map((a) => (
            <AgentRow key={a.id} agent={a} expanded={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} onRemove={() => setRemoving(a)} />
          ))}
        </div>
      </section>
      <AddAgent />
      {removing && <RemoveAgentDialog agent={removing} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function AgentRow({ agent, expanded, onToggle, onRemove }: { agent: AgentConfig; expanded: boolean; onToggle: () => void; onRemove: () => void }) {
  const set = (patch: Parameters<typeof officeActions.updateAgent>[1]) => officeActions.updateAgent(agent.id, patch);
  return (
    <div className="border-[3px] border-ink bg-white">
      <div className="grid grid-cols-[40px_1fr_1fr_150px_auto] items-end gap-2.5 p-2.5">
        <Portrait color={agent.color} lead={agent.isLead} />
        <Field label="Name">
          <CommitInput className="field" value={agent.name} onCommit={(v) => v.trim() && set({ name: v.trim() })} />
        </Field>
        <Field label="Role">
          {agent.isLead ? (
            <div className="field flex h-9 items-center bg-cream-2">Lead</div>
          ) : (
            <CommitInput className="field" value={agent.role} list="role-suggestions" onCommit={(v) => v.trim() && set({ role: v.trim() })} />
          )}
        </Field>
        <Field label="Model">
          <CommitInput className="field" value={agent.model} placeholder="Claude default" list="claude-models" onCommit={(v) => set({ model: v.trim() })} />
        </Field>
        <div className="flex gap-1.5">
          <button className="btn px-2 text-[13px]" aria-expanded={expanded} onClick={onToggle}>
            {expanded ? "Less" : "More"}
          </button>
          {!agent.isLead && (
            <button
              className="btn px-2 text-[13px] text-red"
              onClick={onRemove}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="grid grid-cols-2 gap-3 border-t-[3px] border-ink bg-cream p-3">
          <Field label="Colour">
            <div className="flex flex-wrap gap-1.5">
              {agentPalette.map((c) => (
                <button
                  key={c}
                  className="h-6 w-6 border-[3px] border-ink"
                  style={{ background: c, outline: c === agent.color ? "3px solid #241a2e" : undefined, outlineOffset: 1 }}
                  aria-label={`Colour ${c}`}
                  onClick={() => set({ color: c })}
                />
              ))}
            </div>
          </Field>
          <Field label="Permissions" hint="How this agent asks before acting. Prompts come to Action items as Allow / Deny. Applies on its next start.">
            <select
              className="field"
              value={agent.permissionMode ?? ""}
              // null (not undefined, which JSON drops) tells the server to clear it.
              onChange={(e) => set({ permissionMode: (e.target.value || null) as PermissionMode | undefined })}
            >
              {(Object.keys(PERMISSION_LABEL) as (PermissionMode | "")[]).map((m) => (
                <option key={m} value={m}>
                  {PERMISSION_LABEL[m]}
                </option>
              ))}
            </select>
          </Field>
          <div className="col-span-2">
            <Field label="Folder" hint="Leave empty and Fleet makes a git worktree for this agent under ~/.fleet. Or enter an existing git folder.">
              <CommitInput
                className="field font-term text-[17px]"
                value={agent.workspacePath ?? ""}
                placeholder={`Fleet-managed: ~/.fleet/projects/…/${agent.id}`}
                onCommit={(v) => set({ workspacePath: v.trim() || null })}
              />
            </Field>
          </div>
          <div className="col-span-2">
            <Field label="ROLE.md" hint="Who this agent is and which skills it uses. Fleet adds the team, rules and tools, writes it to .fleet-role.md in the agent's folder (never committed) and loads it when the session starts. A ROLE.md the folder already has is included too, never overwritten.">
              <CommitInput multiline className="field h-[120px] resize-y font-term text-[17px] leading-tight" value={agent.roleMd} onCommit={(v) => set({ roleMd: v })} />
            </Field>
            <FileButton label="Load role from file…" accept=".md,.txt,text/markdown,text/plain" onText={(text) => set({ roleMd: text })} />
          </div>
          <div className="col-span-2">
            <SkillsField skills={agent.skillFiles ?? []} onChange={(skillFiles) => set({ skillFiles })} />
          </div>
        </div>
      )}
    </div>
  );
}

/** A button that reads a text file the user picks. */
function FileButton({ label, accept, onText }: { label: string; accept: string; onText: (text: string, fileName: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn mt-1.5 px-2 text-[13px]" onClick={() => input.current?.click()}>
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = ""; // picking the same file again still fires
          if (file) onText(await file.text(), file.name);
        }}
      />
    </>
  );
}

/** A skill's name: its frontmatter `name:`, else the file name (not a bare "SKILL"). */
function skillName(text: string, fileName = ""): string {
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---/)?.[1];
  const fromFm = fm?.match(/^name:\s*["']?([^"'\n]+)/m)?.[1]?.trim();
  const fromFile = fileName.replace(/\.(md|markdown|txt)$/i, "");
  return fromFm || (/^skill$/i.test(fromFile) ? "" : fromFile);
}

/** Skills for this agent only: paste a SKILL.md or load it from a file. */
function SkillsField({ skills, onChange }: { skills: SkillFile[]; onChange: (next: SkillFile[]) => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const n = name.trim();
    if (!n || !text.trim()) return setError("Give the skill a name and its text.");
    if (new Blob([text]).size > SKILL_LIMITS.bytes) return setError(`A skill can be at most ${SKILL_LIMITS.bytes / 1000} KB.`);
    if (skills.length >= SKILL_LIMITS.count && !skills.some((s) => s.name === n)) return setError(`At most ${SKILL_LIMITS.count} skills per agent.`);
    onChange([...skills.filter((s) => s.name !== n), { name: n, content: text }]);
    setName("");
    setText("");
    setError(null);
  };
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[14px] font-semibold">Skills for this agent</span>
      {skills.length > 0 && (
        <ul className="flex flex-col gap-1">
          {skills.map((s) => (
            <li key={s.name} className="flex items-center justify-between gap-2 border-2 border-ink bg-white px-2 py-0.5 text-[14px]">
              <span className="font-term text-[17px]">{s.name}</span>
              <button type="button" className="btn px-2 text-[12px] text-red" onClick={() => onChange(skills.filter((x) => x.name !== s.name))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-1.5 border-2 border-dashed border-ink p-2">
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Skill name, e.g. run-e2e-tests" aria-label="Skill name" />
        <textarea
          className="field h-[90px] resize-y font-term text-[16px] leading-tight"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a SKILL.md here, or load it from a file"
          aria-label="Skill text"
        />
        <div className="flex flex-wrap items-center gap-2">
          <FileButton
            label="Load SKILL.md…"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            onText={(t, file) => {
              setText(t);
              setName(skillName(t, file) || name);
              setError(null);
            }}
          />
          <button type="button" className="btn mt-1.5 px-2 text-[13px]" onClick={add}>
            Add skill
          </button>
        </div>
        {error && <span className="text-[12px] text-red">{error}</span>}
      </div>
      <span className="text-[12px] text-muted">
        Skills in your ~/.claude/skills already work for every agent. Add one here to give it to this agent only. Fleet writes it to .claude/skills/fleet-&lt;name&gt;/ in the agent's folder (never committed).
      </span>
    </div>
  );
}

function AddAgent() {
  const [name, setName] = useState("");
  const [role, setRole] = useState("Developer");
  const team = useOffice((s) => s.snap?.config.team) ?? [];
  const suggested = nextAgentName(team.map((a) => a.name));
  const add = () => {
    officeActions.addAgent({ name: name.trim() || suggested, role, cli: "claude", mode: "local" });
    setName("");
  };
  return (
    <section className="border-[3px] border-dashed border-ink p-3">
      <SectionTitle>Add an agent</SectionTitle>
      <form
        className="grid grid-cols-[1fr_1fr_auto] items-end gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Field label="Name">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder={suggested} />
        </Field>
        <Field label="Role">
          <input className="field" value={role} list="role-suggestions" onChange={(e) => setRole(e.target.value)} />
        </Field>
        <button className="btn" type="submit">
          Add
        </button>
      </form>
      <p className="mt-2 text-[12px] text-muted">The new agent starts when the lead first gives it work.</p>
      <datalist id="claude-models">
        <option value="opus" />
        <option value="sonnet" />
        <option value="haiku" />
      </datalist>
      <datalist id="role-suggestions">
        {ROLE_SUGGESTIONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </section>
  );
}
