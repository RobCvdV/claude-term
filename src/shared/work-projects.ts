/** Which tracked activity is billable work, as opposed to personal projects.
 *  Used to keep hobby repos out of the workday length in the hours panel. */

/** A cwd under one of these path segments is MendriX work. */
const WORK_SEGMENTS = ['/mendrix_dev/']

/** True when the folder belongs to a work checkout (subfolders included). */
export function isWorkPath(cwd: string): boolean {
  const p = (cwd || '').toLowerCase()
  return WORK_SEGMENTS.some((seg) => p.includes(seg))
}
