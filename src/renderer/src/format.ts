/** A file size for the file windows' chrome: bytes, whole KB, then MB with one
 *  decimal — enough to tell "big" from "too big" at a glance. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
