import { useEffect, useState } from "react";
import { BUILT_IN_ROLES } from "../../data/names";
import type { RoleInfo } from "../../data/types";
import { officeActions, useOffice } from "../../store/office";

const NEW_ROLE = "__new__";

/** The role list (built-ins + the roles you saved), asked for fresh each time a form that picks roles opens. */
export function useRoles(): RoleInfo[] | null {
  useEffect(() => {
    officeActions.listRoles();
  }, []);
  return useOffice((s) => s.roles);
}

/** A worker role: the built-ins, the roles you saved, or "New role…" to name one. */
export function RolePicker({ value, roles, onChange }: { value: string; roles: RoleInfo[] | null; onChange: (role: string) => void }) {
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const list = (roles ?? BUILT_IN_ROLES.map((name) => ({ name, builtIn: true, saved: false }) as RoleInfo)).filter((r) => !r.lead);
  const current = list.find((r) => r.name.toLowerCase() === value.trim().toLowerCase());
  const commit = () => {
    if (draft.trim()) onChange(draft.trim());
    setNaming(false);
  };

  if (naming)
    return (
      <span className="flex gap-1">
        <input
          className="field min-w-0 flex-1"
          autoFocus
          value={draft}
          maxLength={40}
          placeholder="Name it, e.g. Designer"
          aria-label="New role name"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault(); // don't submit the form around it
              commit();
            }
            if (e.key === "Escape") setNaming(false);
          }}
        />
        <button type="button" className="btn px-2 text-[13px]" onClick={commit}>
          OK
        </button>
        <button type="button" className="btn px-2 text-[13px]" aria-label="Cancel new role" onClick={() => setNaming(false)}>
          ✕
        </button>
      </span>
    );

  const option = (r: RoleInfo) => (
    <option key={r.name} value={r.name}>
      {r.name}
      {r.builtIn && r.saved ? " (yours)" : ""}
    </option>
  );
  return (
    <select
      className="field"
      value={current?.name ?? value}
      onChange={(e) => {
        if (e.target.value !== NEW_ROLE) return onChange(e.target.value);
        setDraft("");
        setNaming(true);
      }}
    >
      <optgroup label="Built-in">{list.filter((r) => r.builtIn).map(option)}</optgroup>
      {list.some((r) => !r.builtIn) && <optgroup label="My roles">{list.filter((r) => !r.builtIn).map(option)}</optgroup>}
      {!current && value.trim() && <option value={value}>{value}</option>}
      <option value={NEW_ROLE}>New role…</option>
    </select>
  );
}
