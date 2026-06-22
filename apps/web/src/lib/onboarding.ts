// apps/web/src/lib/onboarding.ts
export const ONBOARDED_KEY = "finance.onboarded";

export function isOnboarded(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(ONBOARDED_KEY) === "1";
}

export function markOnboarded(): void {
  if (typeof window !== "undefined") window.localStorage.setItem(ONBOARDED_KEY, "1");
}

/** True when the first-run wizard should auto-open: the DB has zero accounts,
 *  the user hasn't onboarded, and they aren't already on the wizard. */
export function shouldOnboard(
  accountsCount: number | undefined,
  onboarded: boolean,
  pathname: string,
): boolean {
  return accountsCount === 0 && !onboarded && pathname !== "/welcome";
}
