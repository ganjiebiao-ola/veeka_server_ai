import { lazy } from "react"

// Shown on demand and heavy (markdown, diffs, tables), so each loads in its own chunk.
export const ImpactView = lazy(() => import("./ImpactView").then(m => ({ default: m.ImpactView })))
export const PRReader = lazy(() => import("./PRReader").then(m => ({ default: m.PRReader })))
export const DiagnosticReader = lazy(() => import("./DiagnosticReader").then(m => ({ default: m.DiagnosticReader })))
