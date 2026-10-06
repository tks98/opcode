import { describe, expect, it } from 'vitest'
import { parseLocalUrl, previewHostFor } from '../src/lib/stores/preview.svelte.js'

describe('parseLocalUrl', () => {
  it('recognizes the addresses servers print', () => {
    expect(parseLocalUrl('http://localhost:8000/')).toEqual({ port: 8000, path: '/' })
    expect(parseLocalUrl('http://127.0.0.1:5000')).toEqual({ port: 5000, path: '/' })
    expect(parseLocalUrl('http://0.0.0.0:8080/app?x=1')).toEqual({ port: 8080, path: '/app?x=1' })
    expect(parseLocalUrl('http://[::1]:8000/')).toEqual({ port: 8000, path: '/' })
    expect(parseLocalUrl('http://[::]:3000/hello')).toEqual({ port: 3000, path: '/hello' })
    expect(parseLocalUrl('http://localhost/')).toEqual({ port: 80, path: '/' })
  })

  it('leaves other links alone', () => {
    expect(parseLocalUrl('https://example.com/')).toBeNull()
    expect(parseLocalUrl('http://localhost.example.com:8000/')).toBeNull()
  })
})

describe('previewHostFor', () => {
  it('gives each server its own origin under a wildcard host', () => {
    expect(previewHostFor('pabc123', 'https://*.preview.example.com/')).toBe('https://pabc123.preview.example.com/')
    expect(previewHostFor('pabc123', 'http://*.localhost:5174/')).toBe('http://pabc123.localhost:5174/')
    expect(previewHostFor('pabc123', 'https://default.local.wasmer.site/')).toBe('https://default.local.wasmer.site/')
  })
})
