import { useEffect } from "react";
import { OfficeCanvas } from "./office/OfficeCanvas";
import { connectOffice, useOffice } from "./store/office";
import { ui, useUi } from "./store/ui";
import { DebugPanel } from "./ui/DebugPanel";
import { DrawerHost } from "./ui/drawers/Drawer";
import { ActivityFeed } from "./ui/hud/ActivityFeed";
import { ConnectionBanner } from "./ui/hud/ConnectionBanner";
import { WelcomeModal } from "./ui/setup/WelcomeModal";
import { TeamPanel } from "./ui/hud/TeamPanel";
import { Tooltip } from "./ui/hud/Tooltip";
import { TopBar } from "./ui/hud/TopBar";
import { NewWorkDialog } from "./ui/hud/NewWorkDialog";
import { SettingsModal } from "./ui/settings/SettingsModal";

function useKeyboard() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Never steal keys from inputs.
      if (el && (el.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey)) return;
      const { settings, drawer } = useUi.getState();
      if (e.key === "Escape") {
        if (settings) ui.closeSettings();
        else if (drawer) ui.closeDrawer();
        return;
      }
      if (settings) return;
      let handled = true;
      if (e.key === "d" || e.key === "D") ui.toggleDebug();
      else if (e.key === "+" || e.key === "=") ui.zoom(1);
      else if (e.key === "-") ui.zoom(-1);
      else if (/^[1-9]$/.test(e.key)) {
        const team = useOffice.getState().snap?.config.team ?? [];
        const agent = team[Number(e.key) - 1];
        if (agent) ui.openAgent(agent.id);
      } else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  useEffect(() => connectOffice(), []);
  useKeyboard();
  const ready = useOffice((s) => s.snap !== null);
  const welcome = useOffice((s) => s.live && !!s.snap?.welcome);
  const newWork = useUi((s) => s.newWork);

  return (
    <>
      <OfficeCanvas />
      <ConnectionBanner />
      {ready && (
        <>
          <TopBar />
          {/* No team exists until the welcome is done: its placeholder cards would say "Idle". */}
          {!welcome && <TeamPanel />}
          <ActivityFeed />
          <DrawerHost />
          <DebugPanel />
          <SettingsModal />
          {welcome && <WelcomeModal />}
          {newWork && !welcome && <NewWorkDialog />}
          <Tooltip />
        </>
      )}
    </>
  );
}
