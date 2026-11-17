import { create } from "zustand";

export type DrawerState =
  | { kind: "agent"; id: string; tab?: AgentTab }
  | { kind: "boards"; boardId?: string }
  | { kind: "prs" }
  | { kind: "actions" }
  | null;

export type AgentTab = "task" | "messages" | "history";
export type SettingsTab = "team" | "workflow" | "boards" | "project";

/** Something in the office the camera can fly to. */
export type FocusTarget =
  | { kind: "agent"; id: string }
  | { kind: "plan" }
  | { kind: "prs" }
  | { kind: "env"; name: string }
  | { kind: "home" };

export interface HoverInfo {
  title: string;
  sub?: string;
  x: number;
  y: number;
}

interface UiState {
  drawer: DrawerState;
  settings: { tab: SettingsTab; agentId?: string } | null;
  hover: HoverInfo | null;
  focus: { target: FocusTarget; nonce: number } | null;
  zoomRequest: { delta: number; nonce: number } | null;
  planBoardId: string | null; // board shown on the plan wall; null = newest active (wallBoard)
  debugOpen: boolean;
  /** Side drawer width in px, remembered per browser; `maximized` fills the screen. */
  drawerWidth: number;
  drawerMaximized: boolean;
  /** The New work dialog is open (also opened by the home page with #new-work). */
  newWork: boolean;
  /** The first task from the home page's New project (#new-work=<prompt>), put in the New work dialog. */
  newWorkPrompt: string;
}

const WIDTH_KEY = "fleet.drawerWidth";
export const DRAWER_MIN = 420;
export const DRAWER_DEFAULT = 520;

/** Room left for the office and team panel when the drawer is as wide as it gets. */
export function drawerMax() {
  return Math.max(DRAWER_MIN, window.innerWidth - 32);
}

function savedWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(v) && v >= DRAWER_MIN ? v : DRAWER_DEFAULT;
  } catch {
    return DRAWER_DEFAULT;
  }
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return "";
  }
}

/** The board the plan wall shows unless you pick one: the newest active board, so New work shows up there. */
export const wallBoard = <B extends { status: string; order: number }>(boards: B[]): B | undefined =>
  boards.filter((b) => b.status === "active").sort((a, b) => b.order - a.order)[0];

export const useUi = create<UiState>(() => ({
  drawer: null,
  settings: null,
  hover: null,
  focus: null,
  zoomRequest: null,
  planBoardId: null,
  debugOpen: false,
  drawerWidth: savedWidth(),
  drawerMaximized: false,
  newWork: typeof location !== "undefined" && /^#new-work(=|$)/.test(location.hash),
  newWorkPrompt: typeof location !== "undefined" && location.hash.startsWith("#new-work=") ? safeDecode(location.hash.slice("#new-work=".length)) : "",
}));

let nonce = 0;

export const ui = {
  focus(target: FocusTarget) {
    nonce += 1;
    useUi.setState({ focus: { target, nonce } });
  },
  openAgent(id: string, tab?: AgentTab) {
    useUi.setState({ drawer: { kind: "agent", id, tab } });
    ui.focus({ kind: "agent", id });
  },
  openBoards(boardId?: string) {
    useUi.setState({ drawer: { kind: "boards", boardId } });
    ui.focus({ kind: "plan" });
  },
  openActions() {
    useUi.setState({ drawer: { kind: "actions" } });
  },
  openPrs() {
    useUi.setState({ drawer: { kind: "prs" } });
    ui.focus({ kind: "prs" });
  },
  /** Fleet has no environment drawer: clicking a rack just flies the camera to it. */
  openEnv(name: string) {
    ui.focus({ kind: "env", name });
  },
  closeDrawer() {
    useUi.setState({ drawer: null });
    ui.focus({ kind: "home" });
  },
  openSettings(tab: SettingsTab = "team", agentId?: string) {
    useUi.setState({ settings: { tab, agentId } });
  },
  closeSettings() {
    useUi.setState({ settings: null });
  },
  openNewWork() {
    useUi.setState({ newWork: true });
  },
  closeNewWork() {
    useUi.setState({ newWork: false, newWorkPrompt: "" });
    if (location.hash.startsWith("#new-work")) history.replaceState(null, "", location.pathname + location.search);
  },
  setHover(hover: HoverInfo | null) {
    useUi.setState({ hover });
  },
  zoom(delta: number) {
    nonce += 1;
    useUi.setState({ zoomRequest: { delta, nonce } });
  },
  showBoardOnWall(boardId: string | null) {
    useUi.setState({ planBoardId: boardId });
  },
  setDrawerWidth(px: number) {
    const w = Math.round(Math.min(drawerMax(), Math.max(DRAWER_MIN, px)));
    useUi.setState({ drawerWidth: w, drawerMaximized: false });
    try {
      localStorage.setItem(WIDTH_KEY, String(w));
    } catch {
      /* private window: applies until reload */
    }
  },
  toggleDrawerMaximized() {
    useUi.setState((s) => ({ drawerMaximized: !s.drawerMaximized }));
  },
  toggleDebug() {
    useUi.setState((s) => ({ debugOpen: !s.debugOpen }));
  },
};
