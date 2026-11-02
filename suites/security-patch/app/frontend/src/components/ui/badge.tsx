import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
        success:
          "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
        running:
          "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200",
        paused:
          "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
        failed:
          "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
        cancelled:
          "border-neutral-200 bg-neutral-100 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
        p0: "rounded-sm bg-red-700 font-bold text-white",
        p1: "rounded-sm bg-amber-700 font-bold text-white",
        p2: "rounded-sm bg-blue-700 font-bold text-white",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

const Badge = React.forwardRef<
  HTMLSpanElement,
  React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }
>(function Badge({ className, variant = "default", asChild = false, ...props }, ref) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      ref={ref}
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
})

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

// The one place a run status picks its color. The label text always carries the meaning too.
function runStatusVariant(status: string): BadgeVariant {
  switch (status) {
    case "completed": return "success"
    case "failed": return "failed"
    case "stopped": return "paused"
    case "aborted": return "cancelled"
    case "connecting": case "queued": case "cloning": case "scanning": return "running"
    default: return "secondary"
  }
}

function severityVariant(severity?: string): BadgeVariant {
  return severity === "P0" ? "p0" : severity === "P1" ? "p1" : severity === "P2" ? "p2" : "outline"
}

export { Badge, badgeVariants, runStatusVariant, severityVariant }
