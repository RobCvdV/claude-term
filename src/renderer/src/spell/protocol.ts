export type SpellLang = 'en' | 'nl'

export const SPELL_LANGS: SpellLang[] = ['en', 'nl']

export type WorkerRequest =
  | { type: 'config'; langs: SpellLang[] }
  | { type: 'check'; id: number; words: string[] }
  | { type: 'suggest'; id: number; word: string }

export type WorkerResponse =
  | { type: 'checked'; id: number; bad: string[] }
  | { type: 'suggested'; id: number; suggestions: string[] }
