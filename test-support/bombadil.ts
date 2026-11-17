// Types shared by scripts/bombadil-pi.ts and the per-package Bombadil fixtures in
// packages/<name>/test/bombadil/*.fixture.ts.

/** The throwaway directories the launcher creates for one Pi run. All are absolute. */
export type BombadilRoot = {
  readonly root: string;
  readonly home: string;
  readonly agent: string;
  readonly sessions: string;
  readonly cwd: string;
  readonly tmp: string;
};

/** What a fixture adds to the launch. Every field is optional. */
export type BombadilLaunch = {
  /** Extra Pi CLI arguments, appended after the extensions. */
  readonly args?: readonly string[];
  /** Extra environment for Pi, merged over the launcher's. */
  readonly env?: Readonly<Record<string, string>>;
  /** Settings merged over the launcher's agent settings.json. */
  readonly settings?: Readonly<Record<string, unknown>>;
  /**
   * Launcher defaults to drop, for a spec that needs what they disable: any of "--no-skills",
   * "--no-context-files", "--no-prompt-templates", "--no-tools" (then "--no-builtin-tools" is
   * used, so extension tools stay on) or "--offline".
   */
  readonly omitDefaults?: readonly string[];
  /** A session file to open instead of --no-session. */
  readonly session?: string;
  /** Called after Pi exits, before the throwaway root is removed. */
  readonly dispose?: () => Promise<void> | void;
};

/** A fixture module's default export. */
export type BombadilFixture = (root: BombadilRoot) => Promise<BombadilLaunch> | BombadilLaunch;
