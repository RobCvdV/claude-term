import { describe, expect, it } from 'vitest'
import { suggestWidgetAccepting } from './suggest-widget'

const doc = (widget: Element | null): Pick<Document, 'querySelector'> =>
  ({ querySelector: () => widget }) as unknown as Pick<Document, 'querySelector'>

const widgetWithClasses = (...classes: string[]): Element =>
  ({ classList: { contains: (c: string) => classes.includes(c) } }) as unknown as Element

describe('suggestWidgetAccepting', () => {
  it('is false when no widget is visible', () => {
    expect(suggestWidgetAccepting(doc(null))).toBe(false)
  })

  it('is true when the widget shows a suggestion list', () => {
    expect(suggestWidgetAccepting(doc(widgetWithClasses('suggest-widget', 'visible')))).toBe(true)
  })

  it('is false in the "No suggestions." / "Loading..." message states', () => {
    // e.g. after the delete-retrigger on an @-path matching no project file —
    // Enter must submit the prompt instead of typing a newline
    expect(
      suggestWidgetAccepting(doc(widgetWithClasses('suggest-widget', 'visible', 'message')))
    ).toBe(false)
  })
})
