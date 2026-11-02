import { useEffect, useState } from "react"

export type ThemePref = "system" | "light" | "dark"
export const THEME_PREFS: readonly ThemePref[] = ["system", "light", "dark"]

const KEY = "ola_theme"
const DARK_QUERY = "(prefers-color-scheme: dark)"

function readPref(): ThemePref {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === "light" || saved === "dark") return saved
  } catch {
    // ignore
  }
  return "system"
}

function systemDark() {
  return typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches
}

// index.html runs the same resolution before React mounts, so the first paint already has the right theme.
function apply(pref: ThemePref) {
  const theme = pref === "dark" || (pref === "system" && systemDark()) ? "dark" : "light"
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.style.colorScheme = theme
}

export function useTheme() {
  const [pref, setPrefState] = useState<ThemePref>(readPref)

  useEffect(() => {
    apply(pref)
    if (pref !== "system" || typeof matchMedia !== "function") return
    const query = matchMedia(DARK_QUERY)
    const onChange = () => apply("system")
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [pref])

  function setPref(next: ThemePref) {
    setPrefState(next)
    try {
      if (next === "system") localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
    } catch {
      // ignore
    }
  }

  return { pref, setPref }
}
