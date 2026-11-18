// Choices for the status bar's model and effort dropdowns. Each pick is sent
// to the session as `/model <value>` or `/effort <value>`.

export interface Choice {
  value: string
  label: string
}

export const MODEL_CHOICES: Choice[] = [
  { value: 'default', label: 'Default' },
  { value: 'fable', label: 'Fable' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' }
]

// `auto` hands the level back to the model's default
export const EFFORT_CHOICES: Choice[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'].map(
  (v) => ({ value: v, label: v })
)

/** The model alias the session runs on (from its model id), or null. */
export function currentModelAlias(modelId: string | undefined): string | null {
  const id = (modelId ?? '').toLowerCase()
  return MODEL_CHOICES.find((c) => c.value !== 'default' && id.includes(c.value))?.value ?? null
}
