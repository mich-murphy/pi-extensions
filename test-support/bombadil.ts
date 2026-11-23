export type BombadilRoot = {
  readonly root: string;
  readonly home: string;
  readonly agent: string;
  readonly sessions: string;
  readonly cwd: string;
  readonly tmp: string;
};

export type BombadilLaunch = {
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly omitDefaults?: readonly string[];
  readonly session?: string;
  readonly dispose?: () => Promise<void> | void;
};

export type BombadilFixture = (root: BombadilRoot) => Promise<BombadilLaunch> | BombadilLaunch;
