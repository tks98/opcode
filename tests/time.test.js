import { describe, expect, it } from 'vitest'
import { timeAgo } from '../src/lib/time.js'

describe('timeAgo', () => {
  const now = Date.parse('2026-10-06T12:00:00Z')
  it('describes recent and older times in words', () => {
    expect(timeAgo(now - 10_000, now)).toBe('just now')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 minutes ago')
    expect(timeAgo(now - 3 * 60 * 60_000, now)).toBe('3 hours ago')
    expect(timeAgo(now - 26 * 60 * 60_000, now)).toBe('yesterday')
    expect(timeAgo(now - 9 * 24 * 60 * 60_000, now)).toBe('last week')
    expect(timeAgo(now + 60_000, now)).toBe('just now')
  })
})
