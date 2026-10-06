import { describe, expect, it } from 'vitest'
import { normalizeRelay, relayDnsUrl, siteRelay, v86DohServer, v86RelayUrl } from '../src/lib/stores/network.svelte.js'

describe('relay addresses', () => {
  it('normalizes what people type', () => {
    expect(normalizeRelay('relay.example.com')).toBe('wss://relay.example.com/')
    expect(normalizeRelay('https://relay.example.com/wisp/')).toBe('wss://relay.example.com/wisp/')
    expect(normalizeRelay('ws://localhost:8090')).toBe('ws://localhost:8090/')
    expect(normalizeRelay('  ')).toBe('')
    expect(() => normalizeRelay('ftp://relay.example.com')).toThrow(/wss:\/\//)
  })

  it("reads the site's relay from its settings (config.js)", () => {
    expect(siteRelay(undefined, 'https://opcode.example.com/')).toBeUndefined()
    expect(siteRelay('', 'https://opcode.example.com/')).toBe('')
    expect(siteRelay('wss://relay.example.com/', 'https://opcode.example.com/')).toBe('wss://relay.example.com/')
    expect(siteRelay('https://relay.example.com', 'https://opcode.example.com/')).toBe('wss://relay.example.com/')
    expect(siteRelay('ftp://relay.example.com', 'https://opcode.example.com/')).toBeUndefined()
    // A path on the site itself (the Docker image's built-in relay).
    expect(siteRelay('/wisp/', 'https://opcode.example.com/?project=1')).toBe('wss://opcode.example.com/wisp/')
    expect(siteRelay('/wisp/', 'http://localhost:8080/')).toBe('ws://localhost:8080/wisp/')
  })

  it('derives the DNS endpoint and the emulator settings', () => {
    expect(relayDnsUrl('wss://relay.example.com/wisp/')).toBe('https://relay.example.com/dns-query')
    expect(relayDnsUrl('ws://localhost:8090/')).toBe('http://localhost:8090/dns-query')
    expect(v86RelayUrl('wss://relay.example.com/')).toBe('wisps://relay.example.com/')
    expect(v86RelayUrl('ws://localhost:8090/')).toBe('wisp://localhost:8090/')
    expect(v86DohServer('wss://relay.example.com:8443/')).toBe('relay.example.com:8443')
    expect(v86DohServer('ws://localhost:8090/')).toBeUndefined()
  })
})
