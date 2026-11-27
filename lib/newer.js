// Which side is newer?
//
// A sync that always pushes in the configured direction can quietly overwrite
// the newer copy: import a session, keep working in the original tool, and the
// next export pushes the stale DSH text back over it. So before writing, the
// two sides are compared and the direction is derived from that comparison
// rather than assumed.
//
// The comparison is anchored on the LAST SYNC, not on a direct comparison of
// the two timestamps. That distinction matters more than it looks:
//
//   * A DSH event's `time` is the conversation's own timestamp. Importing a
//     rollout from last year writes events stamped last year, so "newest event
//     time" is not "when DSH was last written".
//   * A file's mtime is when it landed on this disk, not when its content was
//     written - a checkout or a copy makes an ancient conversation look fresh.
//
// Comparing those two directly says "the machine is newer" for a file that was
// merely copied, and the next automatic sync then re-imports it forever. Asking
// instead "did this side change since we last synced?" is symmetric and correct:
// a side that has not moved cannot hold anything the other side is missing.

/** How far two stamps may differ and still count as "the same moment". */
const SLACK_MS = 1000

/**
 * @param {object} input
 * @param {number|undefined} input.externalMtimeMs modification time of the source file
 * @param {number|undefined} input.externalSize size of the source file, when known
 * @param {number|undefined} input.externalPrevMtimeMs mtime recorded at the last sync
 * @param {number|undefined} input.externalPrevSize size recorded at the last sync
 * @param {number|undefined} input.dshTimeAtSync newest DSH event time recorded at the last sync
 * @param {number|undefined} input.dshLastTime newest event time inside the DSH session
 * @param {number|undefined} input.lastSyncAt when this binding last completed a sync
 * @param {string} input.direction the binding's configured direction
 * @returns {{newer: 'external'|'dsh'|'equal'|'unknown', direction: 'in'|'out'|'both', reason: string}}
 */
export function compareSides({
  externalMtimeMs,
  externalSize,
  externalPrevMtimeMs,
  externalPrevSize,
  dshLastTime,
  dshTimeAtSync,
  lastSyncAt,
  direction = 'both',
} = {}) {
  const external = Number(externalMtimeMs)
  const dsh = Number(dshLastTime)
  const synced = Number(lastSyncAt)
  const hasExternal = Number.isFinite(external) && external > 0
  const hasDsh = Number.isFinite(dsh) && dsh > 0
  const hasSync = Number.isFinite(synced) && synced > 0

  // A source that does not exist yet cannot be newer than anything: exporting
  // is the only move that makes sense, and importing has nothing to read.
  if (!hasExternal) {
    return { newer: 'dsh', direction: 'out', reason: 'the source file does not exist yet' }
  }
  // An EMPTY source is the same situation. Its mtime is recent because it was
  // just created, so a pure timestamp comparison calls it "newer by 329d" and
  // then imports nothing at all. Nothing to read means nothing to import.
  if (Number.isFinite(Number(externalSize)) && Number(externalSize) === 0) {
    return { newer: 'dsh', direction: 'out', reason: 'the source file is empty' }
  }
  if (!hasDsh && !hasSync) {
    return { newer: 'external', direction: 'in', reason: 'the DSH session is empty' }
  }

  // Did the source change since we last looked at it? Comparing against the
  // stamp recorded at the last sync is exact; a time window is not, because a
  // real edit made a moment after a sync falls inside any window wide enough to
  // absorb filesystem timestamp coarseness.
  const hasPrev = Number.isFinite(Number(externalPrevMtimeMs)) && Number(externalPrevMtimeMs) > 0
  const sizeDiffers = Number.isFinite(Number(externalPrevSize)) && Number(externalSize) !== Number(externalPrevSize)
  let externalMoved
  if (hasPrev) {
    externalMoved = external !== Number(externalPrevMtimeMs) || sizeDiffers
  } else {
    const baseline = hasSync ? synced : 0
    externalMoved = hasSync ? external > baseline + SLACK_MS : true
  }

  // The DSH side's "last touched" is the later of its newest event and the last
  // time this binding wrote to it - an import stamped with an old conversation
  // time still means DSH was written just now.
  const dshTouchedAt = Math.max(hasDsh ? dsh : 0, hasSync ? synced : 0)
  const hasDshMark = Number.isFinite(Number(dshTimeAtSync)) && Number(dshTimeAtSync) > 0
  const dshMoved = hasDshMark
    ? (hasDsh ? dsh : 0) > Number(dshTimeAtSync)
    : (hasSync ? dshTouchedAt > synced + SLACK_MS : hasDsh)

  if (!externalMoved && !dshMoved) {
    return {
      newer: 'equal',
      direction: direction === 'both' ? 'both' : firstLeg(direction),
      reason: 'neither side changed since the last sync',
    }
  }
  if (externalMoved && !dshMoved) {
    return { newer: 'external', direction: 'in', reason: 'the source changed since the last sync' }
  }
  if (!externalMoved && dshMoved) {
    return { newer: 'dsh', direction: 'out', reason: 'DSH changed since the last sync' }
  }

  // Both moved: the later stamp wins, and a tie is a real conflict.
  const delta = external - dshTouchedAt
  if (Math.abs(delta) <= SLACK_MS) {
    return {
      newer: 'equal',
      direction: direction === 'both' ? 'both' : firstLeg(direction),
      reason: 'both sides changed at the same time',
    }
  }
  if (delta > 0) {
    return {
      newer: 'external',
      direction: 'in',
      reason: `both changed, but the source is newer by ${describe(delta)}`,
    }
  }
  return {
    newer: 'dsh',
    direction: 'out',
    reason: `both changed, but DSH is newer by ${describe(-delta)}`,
  }
}

/**
 * For an explicitly one-sided binding, keep that side even when the comparison
 * says otherwise - the user asked for that direction on purpose. For 'both'
 * the comparison is the whole point, so it decides.
 */
function firstLeg(direction) {
  if (direction === 'in' || direction === 'out') return direction
  return 'both'
}

function describe(ms) {
  if (ms < 1000) return 'less than a second'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * Apply the comparison to a binding's configured direction.
 *
 * 'auto' means "sync whatever changed, and nothing when nothing did" - so a
 * side that has not moved produces no work at all rather than a redundant
 * rewrite of a file that is already correct. An explicit 'in' or 'out' wins over
 * the comparison (the user pinned it). 'both' keeps both legs only when the
 * sides agree; otherwise only the newer side is written.
 */
export function resolveDirection(configured, comparison) {
  if (configured === 'auto') {
    return comparison.newer === 'equal' || comparison.newer === 'unknown' ? 'none' : comparison.direction
  }
  if (configured === 'both') {
    return comparison.newer === 'equal' || comparison.newer === 'unknown' ? 'both' : comparison.direction
  }
  return configured
}
