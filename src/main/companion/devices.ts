import { createPublicKey, randomBytes, timingSafeEqual, verify } from 'crypto'
import { chmodSync, readFileSync, writeFileSync } from 'fs'

/** Signed alongside the nonce so a signature can't be replayed at another host. */
export const AUTH_CONTEXT = 'claude-term/companion/auth/v1'

export interface Device {
  deviceId: string
  name: string
  /** Ed25519 public key, base64 SPKI (what `crypto` exports as 'spki'/'der'). */
  publicKey: string
  pairedAt: number
  lastSeen: number
  /** Expo push token, refreshed on every connect — absent until one is sent. */
  pushToken?: string
}

interface Stored {
  devices: Device[]
}

/** 32 bytes is what a signature must cover; long enough that reuse is not a risk. */
export function newNonce(): string {
  return randomBytes(32).toString('base64')
}

/** The exact bytes a device signs: context first, so it is domain-separated. */
export function authPayload(nonce: string, deviceId: string): Buffer {
  return Buffer.from(`${AUTH_CONTEXT}\n${nonce}\n${deviceId}`, 'utf8')
}

/**
 * Is this signature over our nonce, by the key we hold for this device?
 * Never throws — a malformed key or signature is simply a failed check.
 */
export function verifySignature(
  publicKeyBase64: string,
  nonce: string,
  deviceId: string,
  signatureBase64: string
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki'
    })
    if (key.asymmetricKeyType !== 'ed25519') return false
    return verify(null, authPayload(nonce, deviceId), key, Buffer.from(signatureBase64, 'base64'))
  } catch {
    return false
  }
}

/** Constant-time string compare that tolerates length mismatch. */
export function secretEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    // still burn a comparison so the failure is not distinguishable by timing
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

/**
 * The devices allowed to drive this host. Revoking is a delete: a device that is
 * gone from here cannot authenticate, because authentication *is* holding a key
 * this file names.
 */
export class DeviceRegistry {
  private devices = new Map<string, Device>()

  constructor(private readonly file: () => string) {
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file(), 'utf8')) as Stored
      for (const d of raw.devices ?? []) {
        if (typeof d?.deviceId === 'string' && typeof d?.publicKey === 'string') {
          this.devices.set(d.deviceId, d)
        }
      }
    } catch {
      /* first run, or a file we won't pretend to understand */
    }
  }

  private save(): void {
    try {
      const path = this.file()
      writeFileSync(path, JSON.stringify({ devices: [...this.devices.values()] }, null, 2))
      chmodSync(path, 0o600)
    } catch {
      /* best effort — an unwritable registry must not take the app down */
    }
  }

  list(): Device[] {
    return [...this.devices.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  get(deviceId: string): Device | null {
    return this.devices.get(deviceId) ?? null
  }

  /** Trust a newly paired device. Re-pairing the same id replaces its key. */
  add(device: Omit<Device, 'pairedAt' | 'lastSeen'>): Device {
    const now = Date.now()
    const stored: Device = { ...device, pairedAt: now, lastSeen: now }
    this.devices.set(stored.deviceId, stored)
    this.save()
    return stored
  }

  revoke(deviceId: string): boolean {
    const gone = this.devices.delete(deviceId)
    if (gone) this.save()
    return gone
  }

  touch(deviceId: string, pushToken?: string): void {
    const device = this.devices.get(deviceId)
    if (!device) return
    device.lastSeen = Date.now()
    if (pushToken && pushToken !== device.pushToken) device.pushToken = pushToken
    this.save()
  }

  /** Verify a device's answer to our challenge. */
  authenticate(deviceId: string, nonce: string, signature: string): Device | null {
    const device = this.devices.get(deviceId)
    if (!device) return null
    if (!verifySignature(device.publicKey, nonce, deviceId, signature)) return null
    return device
  }
}
