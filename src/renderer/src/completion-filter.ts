/**
 * Keeping a backend suggestion in Monaco's list.
 *
 * Monaco filters the items a provider returns against the text being replaced,
 * even when the provider says `incomplete: true` — and path pickers answer a
 * home-relative query with absolute paths (`~/Dev` → `/Users/rob/Dev/`), which
 * share no prefix with what was typed. Every suggestion then scores as a
 * non-match and the popup comes up empty, which reads as "`~/` isn't supported".
 *
 * The backend has already filtered; this makes sure Monaco cannot drop its
 * answers.
 */
export function filterFor(typed: string, value: string): string {
  return value.startsWith(typed) ? value : typed + value
}
