export interface MakeExternalIdParts {
  source: string;
  account: string;
  intrinsic: string | null;
  fallback: () => string;
}

export function makeExternalId(parts: MakeExternalIdParts): string {
  const key =
    parts.intrinsic !== null && parts.intrinsic !== ""
      ? parts.intrinsic
      : parts.fallback();
  return `${parts.source}:${parts.account}:${key}`;
}
