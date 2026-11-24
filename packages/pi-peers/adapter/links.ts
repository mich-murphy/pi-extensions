import type { LinkFrame } from "./transport.js";

export type LinkState = {
  readonly machineId: string;
  readonly state: LinkFrame["state"];
  readonly since: number;
  readonly nextProbe?: number;
};
function same(left: LinkState | undefined, right: LinkState): boolean {
  return (
    left !== undefined &&
    left.state === right.state &&
    left.since === right.since &&
    left.nextProbe === right.nextProbe
  );
}
export class LinkTable {
  private readonly entries = new Map<string, LinkState>();
  apply(frame: Omit<LinkFrame, "v" | "op" | "rid">): boolean {
    const next: LinkState = {
      machineId: frame.machineId,
      state: frame.state,
      since: frame.since,
      ...(frame.nextProbe === undefined ? {} : { nextProbe: frame.nextProbe }),
    };
    const changed = !same(this.entries.get(frame.machineId), next);
    this.entries.set(frame.machineId, next);
    return changed;
  }
  clear(): boolean {
    const changed = this.entries.size > 0;
    this.entries.clear();
    return changed;
  }
  list(): readonly LinkState[] {
    return [...this.entries.values()];
  }
  down(machineId: string): boolean {
    const known = this.entries.get(machineId);
    return known !== undefined && known.state !== "up";
  }
}
