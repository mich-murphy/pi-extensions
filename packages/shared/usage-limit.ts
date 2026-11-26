export const USAGE_LIMIT_CHANNEL = "usage-limit";

export type UsageLimitNotice = {
  readonly provider: string | undefined;
  readonly resetsAt: number;
};

function isValidEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(new Date(value).getTime());
}

export function readUsageLimitNotice(data: unknown): UsageLimitNotice | undefined {
  if (typeof data !== "object" || data === null || !("resetsAt" in data)) {
    return undefined;
  }

  const { resetsAt } = data;

  if (!isValidEpoch(resetsAt)) {
    return undefined;
  }

  const provider =
    "provider" in data && typeof data.provider === "string" ? data.provider : undefined;

  return { provider, resetsAt };
}
