/**
 * Whether the suggest popup is open with something Enter/Tab can accept.
 * Monaco keeps the widget `.visible` in its "Loading..." / "No suggestions."
 * message states (explicit triggers only, e.g. the delete-retrigger on an
 * @-path that matches nothing) — there is no focused item then, so deferring
 * Enter to Monaco would type a newline instead of submitting. Treat those
 * states as closed.
 */
export function suggestWidgetAccepting(doc: Pick<Document, 'querySelector'> = document): boolean {
  const widget = doc.querySelector('.suggest-widget.visible')
  return widget !== null && !widget.classList.contains('message')
}
