/** One look for every scrollbar in the app: no track, a thin rounded thumb.
 *  Native bars get it from main.css; Monaco and xterm draw their own, so they
 *  take these. Keep the colours in step with `--scrollbar-*` in main.css. */

export const SCROLLBAR_COLORS = {
  thumb: '#d4d4d838',
  hover: '#d4d4d866',
  active: '#d4d4d88c'
}

/** Monaco's `scrollbar` option: a 10px hit area around a 4px thumb, no shadow. */
export const MONACO_SCROLLBAR = {
  verticalScrollbarSize: 10,
  horizontalScrollbarSize: 10,
  verticalSliderSize: 4,
  horizontalSliderSize: 4,
  useShadows: false
}

/** Monaco theme colours for the same thumb. */
export const MONACO_SCROLLBAR_THEME = {
  'scrollbar.shadow': '#00000000',
  'scrollbarSlider.background': SCROLLBAR_COLORS.thumb,
  'scrollbarSlider.hoverBackground': SCROLLBAR_COLORS.hover,
  'scrollbarSlider.activeBackground': SCROLLBAR_COLORS.active
}

/** xterm theme colours for the same thumb (its width is set in main.css). */
export const XTERM_SCROLLBAR_THEME = {
  scrollbarSliderBackground: SCROLLBAR_COLORS.thumb,
  scrollbarSliderHoverBackground: SCROLLBAR_COLORS.hover,
  scrollbarSliderActiveBackground: SCROLLBAR_COLORS.active
}
