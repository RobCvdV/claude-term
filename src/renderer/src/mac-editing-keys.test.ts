import { describe, expect, it } from 'vitest'
import { macEditingSequence, type KeyLike } from './mac-editing-keys'

const k = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  metaKey: false,
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  ...mods
})

describe('macEditingSequence', () => {
  it('maps ⌘ and ⌥ editing keys to readline keys', () => {
    expect(macEditingSequence(k('ArrowLeft', { metaKey: true }), true)).toBe('\x01')
    expect(macEditingSequence(k('ArrowRight', { metaKey: true }), true)).toBe('\x05')
    expect(macEditingSequence(k('ArrowLeft', { altKey: true }), true)).toBe('\x1bb')
    expect(macEditingSequence(k('ArrowRight', { altKey: true }), true)).toBe('\x1bf')
    expect(macEditingSequence(k('Backspace', { metaKey: true }), true)).toBe('\x15')
    expect(macEditingSequence(k('Backspace', { altKey: true }), true)).toBe('\x17')
    expect(macEditingSequence(k('z', { metaKey: true }), true)).toBe('\x1f')
  })

  it('⇧Enter is a newline only in Claude Code', () => {
    expect(macEditingSequence(k('Enter', { shiftKey: true }), true)).toBe('\n')
    expect(macEditingSequence(k('Enter', { shiftKey: true }), false)).toBeNull()
  })

  it('leaves other combinations alone', () => {
    expect(macEditingSequence(k('ArrowLeft'), true)).toBeNull()
    expect(macEditingSequence(k('ArrowLeft', { metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(macEditingSequence(k('z', { metaKey: true, shiftKey: true }), true)).toBeNull()
    expect(macEditingSequence(k('c', { metaKey: true }), true)).toBeNull()
    expect(macEditingSequence(k('ArrowLeft', { ctrlKey: true, metaKey: true }), true)).toBeNull()
  })
})
