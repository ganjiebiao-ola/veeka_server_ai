export type PRFile = {
  filename: string, previous_filename?: string, status: string,
  additions: number, deletions: number, patch?: string, blob_url: string,
}
export type PRCheck = {
  id: number, name: string, status: string, conclusion: string | null, html_url: string,
  output?: { title: string | null, summary: string | null, text?: string | null },
}
export type PRStatus = { id: number, context: string, state: string, description: string | null, target_url: string | null }
export type PRComment = {
  id: number, body: string, user: { login: string } | null, html_url: string, created_at: string,
  path?: string, line?: number | null, original_line?: number | null, diff_hunk?: string, in_reply_to_id?: number,
}
export type PRReview = {
  id: number, body: string | null, user: { login: string } | null, html_url: string,
  state: string, submitted_at: string | null,
}
export type PRDetail = {
  number: number, title: string, body: string | null, state: "open" | "closed", draft: boolean, merged: boolean,
  html_url: string, user: { login: string } | null, updated_at: string,
  head: { ref: string, sha: string }, base: { ref: string, sha: string },
  additions: number, deletions: number, changed_files: number,
  files: PRFile[], checks: PRCheck[], statuses: PRStatus[], comments: PRComment[], reviews: PRReview[], reviewComments: PRComment[],
  unavailable: Partial<Record<"files" | "checks" | "statuses" | "comments" | "reviews" | "reviewComments", string>>,
}
