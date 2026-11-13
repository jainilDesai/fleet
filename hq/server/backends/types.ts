// How an agent's process is run and reached: tmux, so agents outlive Fleet.

/** What to run, as a program and its arguments (no shell quoting). */
export interface LaunchSpec {
  file: string;
  args: string[];
  /** An env file whose variables the agent gets. Fleet never reads it. */
  envFile: string | null;
}

export interface TermSize {
  cols: number;
  rows: number;
}

export interface ExitInfo {
  dead: boolean;
  exitStatus: number | null;
}

export interface SessionBackend {
  readonly kind: "tmux";
  /** True when agents keep running after HQ stops. */
  readonly persistent: boolean;
  exists(name: string): Promise<boolean>;
  create(name: string, cwd: string, spec: LaunchSpec, size: TermSize): Promise<void>;
  kill(name: string): Promise<void>;
  /** Types text literally (no Enter). */
  type(name: string, text: string): Promise<boolean>;
  enter(name: string): Promise<boolean>;
  /** Whether the agent's process has exited (the session is kept so HQ can say why). */
  exitInfo(name: string): Promise<ExitInfo | null>;
  /** Your unsent text at the agent's prompt ("" when empty or only a suggestion is shown). */
  promptDraft(name: string): Promise<string>;
  /** Last non-empty lines of the screen, plain text. */
  screenText(name: string, lines: number): Promise<string>;
  /** HQ is stopping. */
  shutdown(): void;
}
