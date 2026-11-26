import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export type BombadilRoot = {
  readonly root: string;
  readonly home: string;
  readonly agent: string;
  readonly sessions: string;
  readonly cwd: string;
  readonly tmp: string;
};

export type BombadilLaunch = {
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly settings?: Readonly<ReturnType<SettingsManager["getSettings"]>>;
  readonly omitDefaults?: ReadonlyArray<string>;
  readonly session?: string;
  readonly dispose?: () => Promise<void> | void;
};

export type BombadilFixture = (root: BombadilRoot) => Promise<BombadilLaunch> | BombadilLaunch;
