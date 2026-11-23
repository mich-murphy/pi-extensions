export class Refusal extends Error {
  constructor(
    readonly reason: string,
    readonly fix: string,
  ) {
    super(reason);
  }
}

export class UnsafeFolder extends Refusal {
  constructor(
    readonly folder: string,
    problem: string,
    fix: string,
  ) {
    super(`${folder} ${problem}`, fix);
  }
}

export function sharedFolder(folder: string): UnsafeFolder {
  return new UnsafeFolder(
    folder,
    "is writable by other users",
    `Run chmod go-w ${folder}, then try again`,
  );
}
export function linkedFolder(folder: string): UnsafeFolder {
  return new UnsafeFolder(
    folder,
    "is a link, not a folder",
    "Use a Pi agent folder whose path has no links",
  );
}
export function foreignFolder(folder: string): UnsafeFolder {
  return new UnsafeFolder(
    folder,
    "belongs to another user",
    "Use a Pi agent folder inside your own home",
  );
}
export function openFolder(folder: string): UnsafeFolder {
  return new UnsafeFolder(
    folder,
    "is readable by other users",
    `Run chmod 700 ${folder}, then try again`,
  );
}

export const SETTINGS_CHANGED = (): Refusal =>
  new Refusal("the saved settings changed", "Open /peers again to review them");
export const SETUP_BUSY = (): Refusal =>
  new Refusal("another Pi is changing the setup", "Wait for it to finish, then try again");
