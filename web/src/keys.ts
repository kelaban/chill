// LG webOS remote key codes (plus keyboard equivalents for laptops and tests).
export const KEY = {
  BACK: 461,
  PLAY: 415,
  PAUSE: 19,
  PLAY_PAUSE: 179,
  STOP: 413,
  FF: 417,
  RW: 412,
  RED: 403,
  GREEN: 404,
  YELLOW: 405,
  BLUE: 406,
} as const;

export function isBack(e: KeyboardEvent): boolean {
  if (e.keyCode === KEY.BACK || e.key === "GoBack" || e.key === "BrowserBack" || e.key === "Escape") return true;
  const t = e.target as HTMLElement | null;
  const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
  return e.key === "Backspace" && !typing;
}

export function isTV(): boolean {
  return /Web0S|webOS|SmartTV/i.test(navigator.userAgent) || document.documentElement.classList.contains("tv");
}
