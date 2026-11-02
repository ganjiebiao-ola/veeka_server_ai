import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useI18n } from "../i18n"
import { THEME_PREFS, useTheme } from "../theme"

export type NavTarget = "landing" | "run" | "pick" | "overview" | "history"

const segment = "inline-flex shrink-0 gap-0.5 rounded-md border p-0.5"
const pressed = (on: boolean) => cn("text-muted-foreground", on && "bg-accent text-accent-foreground")

// `run` is set while a run is going or on screen. It adds a Run tab, with a dot when the run is live.
export function NavBar(props: { current?: NavTarget; go: (target: NavTarget) => void; run?: { live: boolean } }) {
  const { lang, setLang, t } = useI18n()
  const { pref, setPref } = useTheme()

  const links: [NavTarget, string][] = [
    ["landing", t("nav.start")],
    ...(props.run ? [["run", t("nav.run")] as [NavTarget, string]] : []),
    ["pick", t("nav.pick")],
    ["overview", t("nav.overview")],
    ["history", t("nav.history")],
  ]

  return (
    <nav className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b bg-background px-4 sm:gap-6 sm:px-6" aria-label={t("nav.label")}>
      <span className="hidden text-[15px] font-bold whitespace-nowrap min-[901px]:inline"><span aria-hidden="true">🛠️</span> {t("nav.brand")}</span>
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {links.map(([target, label]) => (
          <Button
            key={target}
            type="button"
            variant="ghost"
            size="sm"
            className={cn("font-normal text-muted-foreground", props.current === target && "bg-accent font-semibold text-accent-foreground")}
            aria-current={props.current === target ? "page" : undefined}
            onClick={() => props.go(target)}
          >
            {label}
            {target === "run" && props.run?.live && <span className="size-1.5 animate-pulse rounded-full bg-sky-600 dark:bg-sky-400" aria-hidden="true" />}
          </Button>
        ))}
      </div>
      <div className={segment} role="group" aria-label={t("theme.label")}>
        {THEME_PREFS.map(value => (
          <Button
            key={value}
            type="button"
            variant="ghost"
            size="xs"
            className={pressed(pref === value)}
            aria-pressed={pref === value}
            onClick={() => setPref(value)}
          >
            {t(`theme.${value}`)}
          </Button>
        ))}
      </div>
      <div className={segment} role="group" aria-label={t("nav.language")}>
        <Button type="button" variant="ghost" size="xs" className={pressed(lang === "en")} onClick={() => setLang("en")}
          aria-label="Switch to English" lang="en" aria-pressed={lang === "en"}>
          EN
        </Button>
        <Button type="button" variant="ghost" size="xs" className={pressed(lang === "zh")} onClick={() => setLang("zh")}
          aria-label="切换为中文" lang="zh" aria-pressed={lang === "zh"}>
          中文
        </Button>
      </div>
    </nav>
  )
}
