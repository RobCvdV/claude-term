import { describe, expect, it } from 'vitest'
import { bindAddresses, isTailscaleV4, reachableAddress, type NetIface } from './bind-address'

const iface = (address: string, over: Partial<NetIface> = {}): NetIface => ({
  address,
  family: 'IPv4',
  internal: false,
  ...over
})

describe('isTailscaleV4', () => {
  it('accepts the CGNAT range Tailscale allocates from', () => {
    expect(isTailscaleV4('100.64.0.1')).toBe(true)
    expect(isTailscaleV4('100.101.102.103')).toBe(true)
    expect(isTailscaleV4('100.127.255.254')).toBe(true)
  })

  it('rejects addresses just outside it', () => {
    expect(isTailscaleV4('100.63.255.255')).toBe(false)
    expect(isTailscaleV4('100.128.0.1')).toBe(false)
  })

  it('rejects ordinary LAN and public addresses', () => {
    for (const a of ['192.168.1.10', '10.0.0.5', '172.16.0.1', '8.8.8.8', '99.64.0.1']) {
      expect(isTailscaleV4(a), a).toBe(false)
    }
  })

  it('rejects malformed input', () => {
    for (const a of ['', '100.64', 'fe80::1', '100.abc.0.1'])
      expect(isTailscaleV4(a), a).toBe(false)
  })
})

describe('bindAddresses', () => {
  it('always includes loopback', () => {
    expect(bindAddresses({})).toEqual(['127.0.0.1'])
  })

  it('adds the tailnet address and nothing else', () => {
    const addrs = bindAddresses({
      lo0: [iface('127.0.0.1', { internal: true })],
      en0: [iface('192.168.1.20')],
      utun4: [iface('100.101.5.9')]
    })
    expect(addrs).toEqual(['127.0.0.1', '100.101.5.9'])
  })

  it('never binds a LAN interface, even with no tailnet present', () => {
    expect(bindAddresses({ en0: [iface('192.168.1.20')] })).toEqual(['127.0.0.1'])
  })

  it('skips IPv6 and internal interfaces', () => {
    const addrs = bindAddresses({
      utun4: [iface('fd7a::1', { family: 'IPv6' }), iface('100.70.1.1', { internal: true })]
    })
    expect(addrs).toEqual(['127.0.0.1'])
  })

  it('reports the tailnet address to advertise, or nothing to advertise', () => {
    expect(reachableAddress({ utun4: [iface('100.70.1.1')] })).toBe('100.70.1.1')
    expect(reachableAddress({ en0: [iface('192.168.1.20')] })).toBeNull()
  })
})
