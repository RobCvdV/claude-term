/**
 * Which Monaco language to highlight a config file with.
 *
 * Only the languages imported by monaco-setup.ts may be returned — anything
 * else falls back to `plaintext`. Where no exact tokenizer exists we pick the
 * closest one that doesn't actively mislead (`.toml`/`.env`/`.properties` are
 * close enough to ini; `*.gradle` to java), and prefer plaintext over a
 * tokenizer that would colour the file wrongly (`.gitignore`, `Makefile`).
 */

export const PLAINTEXT = 'plaintext'

/** Files whose whole name determines the language. */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  podfile: 'ruby',
  gemfile: 'ruby',
  brewfile: 'ruby',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.env': 'ini',
  // JSON despite having no .json extension
  '.watchmanconfig': 'json',
  // exceptions to the "bare .*rc is JSON" rule below — these hold a bare value
  '.nvmrc': PLAINTEXT
}

const BY_EXTENSION: Record<string, string> = {
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  js: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  plist: 'xml',
  // Delphi project files are XML; the sources are Pascal
  dproj: 'xml',
  groupproj: 'xml',
  dpr: 'pascal',
  dpk: 'pascal',
  pas: 'pascal',
  inc: 'pascal',
  // no toml/properties tokenizer ships with monaco — ini is the closest fit
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  properties: 'ini',
  dof: 'ini',
  gradle: 'java',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  md: 'markdown'
}

/** `.env.local`, `.env.production` … all read as env files. */
const ENV_FILE = /^\.env(\..+)?$/i

/** A bare `.somethingrc` is JSON by convention (.prettierrc, .babelrc). */
const BARE_RC = /^\..*rc$/i

export function languageForFile(fileName: string): string {
  const name = (fileName.split('/').pop() ?? fileName).toLowerCase()

  if (BY_NAME[name]) return BY_NAME[name]
  if (ENV_FILE.test(name)) return 'ini'
  if (BARE_RC.test(name)) return 'json'

  // longest-suffix first so ".config.ts" resolves on "ts", not on "config.ts"
  const dot = name.lastIndexOf('.')
  if (dot > 0) {
    const ext = name.slice(dot + 1)
    if (BY_EXTENSION[ext]) return BY_EXTENSION[ext]
  }

  return PLAINTEXT
}
