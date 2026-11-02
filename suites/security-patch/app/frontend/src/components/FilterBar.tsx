import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import { useI18n } from "../i18n"

// "" means All, so a row with an empty field needs its own option value.
const EMPTY = "__empty__"

export type FilterField<K extends string> = { key: K, label: string, values: string[], text?: (value: string) => string }

// Options keep the order of `values`, without repeats.
export function FilterBar<K extends string>({ fields, value, onChange }: {
  fields: FilterField<K>[], value: Record<K, string>, onChange: (value: Record<K, string>) => void
}) {
  const { t } = useI18n()
  return <div role="group" className="grid grid-cols-[repeat(auto-fill,minmax(180px,220px))] gap-3" aria-label={t("pick.filters")}>
    {fields.map(field => <Label className="min-w-0 flex-col items-stretch gap-1.5" key={field.key}>
      <span>{field.label}</span>
      <NativeSelect className="bg-background font-normal" value={value[field.key]} onChange={e => onChange({ ...value, [field.key]: e.target.value })}>
        <option value="">{t("common.all")}</option>
        {[...new Set(field.values)].map(v => <option key={v} value={v || EMPTY}>{!v ? t("common.unspecified") : field.text ? field.text(v) : v}</option>)}
      </NativeSelect>
    </Label>)}
  </div>
}

export const matchesFilters = <K extends string>(row: Record<NoInfer<K>, string>, value: Record<K, string>): boolean =>
  (Object.keys(value) as K[]).every(key => !value[key] || row[key] === (value[key] === EMPTY ? "" : value[key]))
