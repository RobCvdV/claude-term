import { useEffect, useState } from 'react'
import {
  getSpellConfig,
  onSpellConfigChange,
  setSpellConfig,
  SPELL_LANGS,
  type SpellLang
} from '../spell'

const LABELS: Record<SpellLang, string> = { en: 'EN', nl: 'NL' }

/**
 * The EN/NL chip in the corner of the prompt box: which dictionaries spell
 * checking uses, one click per language. Turning both off means no spell
 * checking — same as `/spell off`, which this stays in sync with.
 */
export function SpellToggle(): React.JSX.Element {
  const [config, setConfig] = useState(getSpellConfig)

  // /spell (this window) or the docs window can change it too
  useEffect(() => onSpellConfigChange(() => setConfig(getSpellConfig())), [])

  const isOn = (lang: SpellLang): boolean => config.enabled && config.langs.includes(lang)

  const toggle = (lang: SpellLang) => (): void => {
    const on = isOn(lang)
    const langs = on ? config.langs.filter((l) => l !== lang) : [...config.langs, lang]
    // clicking a language while everything is off turns checking back on with
    // just that one, rather than silently doing nothing
    setSpellConfig({ ...config, enabled: true, langs: on ? langs : [...new Set(langs)] })
  }

  return (
    <div
      className="spell-toggle"
      // never pull the caret out of the editor (see focus-loan/focus-policy)
      onMouseDown={(e) => e.preventDefault()}
    >
      {SPELL_LANGS.map((lang) => (
        <button
          key={lang}
          className={`spell-lang ${isOn(lang) ? 'on' : ''}`}
          onClick={toggle(lang)}
          aria-pressed={isOn(lang)}
          title={`${LABELS[lang]} spell checking: ${isOn(lang) ? 'on' : 'off'}`}
        >
          {LABELS[lang]}
        </button>
      ))}
    </div>
  )
}
