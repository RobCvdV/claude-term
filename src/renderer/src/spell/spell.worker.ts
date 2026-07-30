// Hunspell (via nspell) off the main thread. Building a dictionary parses a few
// hundred thousand words, so it must never block typing; the renderer only ever
// asks this worker two things — "is this word known?" and "what did they mean?".
import nspell from 'nspell'
// Deep .aff/.dic imports are blocked by the dictionary packages' `exports` maps,
// so they come in through the `@dict` alias (see electron.vite.config.ts).
import enAff from '@dict/dictionary-en/index.aff?raw'
import enDic from '@dict/dictionary-en/index.dic?raw'
import nlAff from '@dict/dictionary-nl/index.aff?raw'
import nlDic from '@dict/dictionary-nl/index.dic?raw'
import type { SpellLang, WorkerRequest, WorkerResponse } from './protocol'

const SOURCES: Record<SpellLang, { aff: string; dic: string }> = {
  en: { aff: enAff, dic: enDic },
  nl: { aff: nlAff, dic: nlDic }
}

type Speller = ReturnType<typeof nspell>

const loaded = new Map<SpellLang, Speller>()
let langs: SpellLang[] = ['en']

function spellers(): Speller[] {
  return langs.map((lang) => {
    let s = loaded.get(lang)
    if (!s) {
      s = nspell(SOURCES[lang].aff, SOURCES[lang].dic)
      loaded.set(lang, s)
    }
    return s
  })
}

function post(message: WorkerResponse): void {
  self.postMessage(message)
}

self.onmessage = (e: MessageEvent<WorkerRequest>): void => {
  const msg = e.data
  if (msg.type === 'config') {
    langs = msg.langs
    return
  }
  const active = spellers()
  if (msg.type === 'check') {
    // known in ANY active language is good enough — text here is English with
    // Dutch product/UI terms mixed in, not one language per document.
    const bad = msg.words.filter((w) => !active.some((s) => s.correct(w)))
    post({ type: 'checked', id: msg.id, bad })
    return
  }
  const seen = new Set<string>()
  const suggestions: string[] = []
  for (const s of active) {
    for (const w of s.suggest(msg.word)) {
      if (!seen.has(w)) {
        seen.add(w)
        suggestions.push(w)
      }
    }
  }
  post({ type: 'suggested', id: msg.id, suggestions })
}
