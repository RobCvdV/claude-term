/** Which badge a file row shows, by name. A table rather than code, so a user
 *  setting can later put its own rules in front of these. */

export interface FileIcon {
  /** short type badge ("TS"); a gear when absent */
  text?: string
  /** a CSS colour or var() */
  color: string
}

export interface IconRule {
  /** exact file names, lower case */
  names?: string[]
  /** extensions without the dot, lower case; the longest match wins (`d.ts`) */
  exts?: string[]
  /** tested against the lower-cased file name */
  pattern?: RegExp
  icon: FileIcon
}

const CONFIG: FileIcon = { color: 'var(--fg-dim)' }

export const DEFAULT_ICON_RULES: IconRule[] = [
  // config first: `vite.config.ts` is configuration before it is TypeScript
  {
    pattern: /(^|\.)(config|rc)\.[cm]?[jt]s$|^\.[\w-]*rc(\.\w+)?$|^\.env(\..*)?$/,
    icon: CONFIG
  },
  {
    names: [
      '.gitignore',
      '.gitattributes',
      '.editorconfig',
      '.npmignore',
      '.prettierignore',
      '.eslintignore',
      'dockerfile',
      'makefile',
      'podfile'
    ],
    icon: CONFIG
  },
  {
    exts: ['ini', 'toml', 'yaml', 'yml', 'cfg', 'conf', 'properties', 'dproj', 'gradle', 'plist'],
    icon: CONFIG
  },
  { exts: ['d.ts'], icon: { text: 'DTS', color: 'var(--blue)' } },
  { exts: ['ts', 'mts', 'cts'], icon: { text: 'TS', color: 'var(--blue)' } },
  { exts: ['tsx'], icon: { text: 'TSX', color: 'var(--cyan)' } },
  { exts: ['js', 'mjs', 'cjs'], icon: { text: 'JS', color: 'var(--yellow)' } },
  { exts: ['jsx'], icon: { text: 'JSX', color: 'var(--yellow)' } },
  { exts: ['pas', 'dpr', 'dpk', 'inc'], icon: { text: 'PAS', color: 'var(--red)' } },
  { exts: ['dfm', 'fmx'], icon: { text: 'DFM', color: 'var(--red)' } },
  { exts: ['json', 'jsonc', 'json5'], icon: { text: '{}', color: 'var(--orange)' } },
  { exts: ['md', 'mdx'], icon: { text: 'MD', color: 'var(--fg-dim)' } },
  { exts: ['css', 'scss', 'less'], icon: { text: 'CSS', color: 'var(--magenta)' } },
  { exts: ['html', 'htm'], icon: { text: 'HTM', color: 'var(--orange)' } },
  { exts: ['sh', 'zsh', 'bash'], icon: { text: 'SH', color: 'var(--green)' } },
  { exts: ['py'], icon: { text: 'PY', color: 'var(--blue)' } },
  { exts: ['java', 'kt'], icon: { text: 'JV', color: 'var(--orange)' } },
  { exts: ['swift'], icon: { text: 'SW', color: 'var(--orange)' } },
  { exts: ['xml', 'svg'], icon: { text: 'XML', color: 'var(--orange)' } },
  { exts: ['sql'], icon: { text: 'SQL', color: 'var(--cyan)' } }
]

const extsOf = (name: string): string[] => {
  const parts = name.split('.').slice(1)
  // longest first: "a.d.ts" → ["d.ts", "ts"]
  return parts.map((_, i) => parts.slice(i).join('.')).filter(Boolean)
}

/** The badge for a file, or undefined for a plain file. */
export function iconFor(
  name: string,
  rules: IconRule[] = DEFAULT_ICON_RULES
): FileIcon | undefined {
  const lower = name.toLowerCase()
  const exts = extsOf(lower)
  for (const rule of rules) {
    if (rule.names?.includes(lower)) return rule.icon
    if (rule.pattern?.test(lower)) return rule.icon
  }
  for (const ext of exts) {
    const rule = rules.find((r) => r.exts?.includes(ext))
    if (rule) return rule.icon
  }
  return undefined
}
