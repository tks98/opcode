// Friendly relative times: "just now", "5 minutes ago", "yesterday".

const formatter = typeof Intl !== 'undefined' ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }) : null

const UNITS = [
  ['year', 365 * 24 * 60 * 60_000],
  ['month', 30 * 24 * 60 * 60_000],
  ['week', 7 * 24 * 60 * 60_000],
  ['day', 24 * 60 * 60_000],
  ['hour', 60 * 60_000],
  ['minute', 60_000],
]

export function timeAgo(timestamp, now = Date.now()) {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000 || !formatter) return 'just now'
  for (const [unit, ms] of UNITS) {
    if (elapsed >= ms) return formatter.format(-Math.floor(elapsed / ms), unit)
  }
  return 'just now'
}
