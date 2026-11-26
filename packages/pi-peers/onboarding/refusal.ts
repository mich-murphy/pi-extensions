export class RefusalError extends Error {
  constructor(
    readonly reason: string,
    readonly fix: string,
  ) {
    super(reason);
  }
}

export class UnsafeFolderError extends RefusalError {
  constructor(
    readonly folder: string,
    problem: string,
    fix: string,
  ) {
    super(`${folder} ${problem}`, fix);
  }
}

export function sharedFolder(folder: string): UnsafeFolderError {
  return new UnsafeFolderError(
    folder,
    "is writable by other users",
    `Run chmod go-w ${folder}, then try again`,
  );
}

export function linkedFolder(folder: string): UnsafeFolderError {
  return new UnsafeFolderError(
    folder,
    "is a link, not a folder",
    "Use a Pi agent folder whose path has no links",
  );
}

export function foreignFolder(folder: string): UnsafeFolderError {
  return new UnsafeFolderError(
    folder,
    "belongs to another user",
    "Use a Pi agent folder inside your own home",
  );
}

export function openFolder(folder: string): UnsafeFolderError {
  return new UnsafeFolderError(
    folder,
    "is readable by other users",
    `Run chmod 700 ${folder}, then try again`,
  );
}

export const SETTINGS_CHANGED = (): RefusalError =>
  new RefusalError("the saved settings changed", "Open /peers again to review them");

export const SETUP_BUSY = (): RefusalError =>
  new RefusalError("another Pi is changing the setup", "Wait for it to finish, then try again");
