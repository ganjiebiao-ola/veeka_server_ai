import type { ComponentProps } from "react"
import { cn } from "@/lib/utils"

// The page container every top-level page renders.
export function Page({ className, ...props }: ComponentProps<"main">) {
  return <main
    className={cn("mx-auto flex w-full max-w-[1760px] flex-col gap-4 px-4 pt-6 pb-12 outline-none sm:px-6", className)}
    {...props}
  />
}
