# UI conventions (shadcn/ui)

The UI is shadcn/ui (style `new-york`, base color `neutral`, Tailwind CSS v4).
Components live in `src/components/ui/` and import as `@/components/ui/<name>`. `cn()` is in `@/lib/utils`.

## Rules

- No new raw CSS classes in pages. Use Tailwind utilities and `ui/` components.
- Keep i18n keys and EN/ZH wording. New text goes in `src/i18n.tsx` for both languages.
- Keep the roles, `aria-*`, `id`s and `data-testid`s tests rely on. Errors keep `role="alert"`, live status keeps `role="status"`.
- Never convey meaning by color alone: a badge or alert always carries its text.
- Add more shadcn components with `bunx --bun shadcn@4.22.1 add <name>`, then fix the import it writes
  (`from "cn"` -> `from "@/lib/utils"`) and do not keep any dependency it adds to package.json.
- React is 18. A ui component that Radix may pass a `ref` to (an `asChild` child, a direct child of a Portal)
  must use `React.forwardRef`. Button, Badge, Input, Textarea and the dialog/sheet overlays already do.
- A Dialog/AlertDialog/Sheet opened without a Radix `Trigger` reads `document.activeElement` in a `useState` initializer
  and refocuses it in `onCloseAutoFocus` (see `ConfirmDialog`, `ReaderModal`). Radix only restores focus to a Trigger.
- Colors: theme tokens (`bg-background`, `text-muted-foreground`, `border`, ...) or the Badge/Alert variants.
  Error text outside an Alert: `text-red-700 dark:text-red-400`.

## Component map

| Old pattern | Use |
|---|---|
| `<main className="page">`, `page--narrow` | `<Page>` from `components/Page.tsx` (passes `tabIndex` etc.) |
| `page-header`, `page-header__title/__subtitle/__actions` | `<header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">` with `<h1 className="text-2xl font-semibold tracking-tight">`, subtitle `<p className="text-sm text-muted-foreground">` |
| `card`, `card__header`, `card__title`, `card__footer` | `Card`, `CardHeader`, `CardTitle` (or an `h2 className="leading-none font-semibold"` inside `CardHeader`), `CardContent`, `CardFooter` |
| `btn btn--primary` / `btn--ghost` / `btn--danger` / `btn--small` | `Button` / `variant="outline"` / `variant="destructive"` / `size="sm"` |
| link styled as a button | `<Button asChild><a ...>label<ExternalLink aria-hidden="true" /></a></Button>` |
| disabled button with a `title` explaining why | add `className="disabled:pointer-events-auto disabled:cursor-not-allowed"` so the title still shows |
| `field`, `field__label`, `field__input` (select) | `<Label className="min-w-0 flex-col items-stretch gap-1.5"><span>label</span><NativeSelect className="bg-background font-normal">` with plain `<option>`s |
| text input / textarea | `Input` / `Textarea` with a `Label htmlFor` |
| checkbox | `Checkbox` |
| `notice notice--info/--warning/--danger` | `Alert variant="info" / "warning" / "destructive"` + `AlertDescription` (or `AlertTitle`) |
| notice with actions (`notice__actions`) | `<Alert variant=... className="flex flex-wrap items-center justify-between gap-3">` with plain spans |
| `status-pill status-pill--<status>` | `<Badge variant={runStatusVariant(status)}><RunStatusLabel run={...} /></Badge>` |
| `sev sev--P0` | `<Badge variant={severityVariant(sev)}>{sev}</Badge>` |
| category / count chip, `count-badge` | `Badge variant="secondary"` or `"outline"` |
| `table-wrap` + `data-table` | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` (Table already scrolls on x). Numbers: `className="text-right tabular-nums"`. Row header: `<TableHead scope="row">` |
| native `<dialog className="modal">` confirmation | `ConfirmDialog` (AlertDialog) or `AlertDialog` parts directly |
| `tracker-modal` reader | `ReaderModal` (Dialog) |
| side panel | `Sheet` |
| fold inside a card | `Accordion` (with `forceMount` + `[[data-state=closed]>&]:hidden` to keep content mounted) or `Collapsible` styled like `AccordionTrigger`: chevron-right on the left, rotates 90°, `py-3 text-sm font-semibold` |
| card that folds | `FoldPanel` (`components/ActivityArea.tsx`), or a `Collapsible` card with the same header (`px-4 py-3`, `hover:bg-muted/50`) and `border-t` content |
| tab strip | `Tabs` |
| hover help | `title` |
| `empty-state`, loading text | `<p role="status" className="py-12 text-center text-muted-foreground">` or `Skeleton` |
| pager | `Pagination` |
| `hr` / divider | `border-t` |
| progress bar | `Progress` |
| menu | `DropdownMenu` |

Toasts: none. Errors and results stay inline in an `Alert`.

## Badge variants

Defined once in `src/components/ui/badge.tsx`. Contrast is at least 5:1 in both themes.

| Variant | For | Helper |
|---|---|---|
| `success` | completed | `runStatusVariant("completed")` |
| `running` | connecting, queued, cloning, scanning | `runStatusVariant(...)` |
| `paused` | stopped (resumable) | `runStatusVariant("stopped")` |
| `failed` | failed | `runStatusVariant("failed")` |
| `cancelled` | aborted | `runStatusVariant("aborted")` |
| `p0` `p1` `p2` | severities | `severityVariant("P1")`. Anything else gets `outline`. |
| `default` `secondary` `outline` `destructive` | shadcn defaults (categories, counts) | |

Alert variants: `default`, `info`, `warning`, `destructive`. Alert has no default role: pass `role="alert"` for errors.

## Spacing and type

- Page: `<Page>` = `max-w-[1760px]`, `px-4 sm:px-6`, `pt-6 pb-12`, sections `gap-4`. Every page uses it. A form keeps its fields readable with `max-w-5xl` on the card content, not a narrower page.
- Page heading: `h1 text-2xl font-semibold tracking-tight`.
- Section or card heading: `h2 leading-none font-semibold` (15–16px).
- Small labels: `text-[11px] font-semibold uppercase tracking-wider text-muted-foreground`.
- Body text: `text-sm`. Secondary text: `text-[13px] text-muted-foreground`. Meta text: `text-xs`.
- Gaps: inline controls `gap-2`, groups `gap-3`, sections `gap-4`.
- Card padding comes from `ui/card.tsx` (`py-5`/`px-5`, `gap-4`, `4` on phones). Do not override it per card; a fold card uses `py-0` with `px-5 max-sm:px-4` on the fold.
- A character counter sits under its field at the right: `self-end text-xs text-muted-foreground tabular-nums`.
- Tables: shadcn density (cells `p-2`, head `h-10`). Long text cells: `[overflow-wrap:anywhere]`.
- Mobile: touch targets in dialogs `max-sm:h-10`. No horizontal page scroll (wrap rows with `flex-wrap`).

## Theme and global CSS

`src/theme.ts` (and the inline script in `index.html`) toggles `.dark` on `<html>`.
`src/styles/global.css` holds only the shadcn theme tokens, a few base rules (14px body, pointer cursor on buttons,
blue plain links `a:not([data-slot])`, focus outline) and `.markdown-body` for rendered markdown. No other CSS classes.

## Tests

The test harness renders one component deep, so a ui component appears as itself, not its tag.
Use `is(node, "button")` from `tests/render.tsx`: it matches the tag and the ui component
(Button, Input, Textarea, NativeSelect, Label, Table parts). Select by text, role, `aria-*` or `data-testid`,
not by `className`. Dialog content renders in a portal, which static markup skips: render the component with
`harness()` and assert on its props/children (see `tests/tracker_modal_test.tsx`, `reader_controls_test.tsx`).
