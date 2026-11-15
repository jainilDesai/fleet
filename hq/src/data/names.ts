/** The lead is the CTO: it plans and hands work to the role agents. */
export const LEAD_NAME = "CTO";
/** The default team under the CTO: one agent per step of the workflow. */
export const DEFAULT_ROLES = ["Planner", "Implementer", "QA", "Reviewer", "Deployer"];
/** Built-in roles in the role picker: the default team plus a plain Developer. */
export const BUILT_IN_ROLES = [...DEFAULT_ROLES, "Developer"];
/** A role's file name in ~/.fleet/roles: cto for the lead, else the lowercased role name. */
export const roleKey = (role: string, isLead = false) => (isLead ? "cto" : role.trim().toLowerCase().replace(/[^a-z0-9-]/g, ""));
/** A name you can save a role under (it becomes a file name). */
export const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9 _+-]{0,39}$/;
/** ROLE.md for a role with no text of its own (Developer, or a new role you name). */
export const genericRoleMd = (name: string, role: string) => `You are ${name}, a ${role.toLowerCase()} on the team. You do the tasks the lead assigns you.`;
/** Names for agents added later, from The Office (US). */
export const WORKER_NAMES = ["Dwight", "Jim", "Pam", "Angela", "Kevin", "Oscar", "Stanley", "Phyllis", "Andy", "Creed", "Meredith"];

/** The first default worker name nobody on the team uses yet. */
export function nextAgentName(taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  return WORKER_NAMES.find((n) => !used.has(n.toLowerCase())) ?? `Agent ${taken.length + 1}`;
}

/** The sign on the office wall fits 19 small pixel letters (10 big ones). */
export const OFFICE_NAME_MAX = 19;
export const DEFAULT_OFFICE_NAME = "FLEET";

export function officeSign(name?: string): string {
  return (name ?? "").trim().slice(0, OFFICE_NAME_MAX) || DEFAULT_OFFICE_NAME;
}
