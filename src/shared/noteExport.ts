/** Sharing meeting notes without any server: Markdown for copy/export, a mailto: link for email. */

// Many mail clients and OS handlers truncate or reject mailto: URLs beyond ~2000 characters.
const MAX_MAILTO_BODY_CHARS = 1800
const TRUNCATION_NOTICE = '\n\n[Shortened for email. Use "Save as .md file" in Notto to share the full notes.]'

export function buildNoteMarkdown(title: string, body: string): string {
  const cleanTitle = title.trim() || 'Untitled note'
  const cleanBody = body.trim()
  // Meeting notes often already start with their own heading.
  if (/^#\s/.test(cleanBody)) return `${cleanBody}\n`
  return `# ${cleanTitle}\n\n${cleanBody}\n`
}

/** File name for the exported note: the title without characters Windows/macOS forbid. */
export function noteExportFileName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  return `${safe || 'Notto note'}.md`
}

export function buildNoteMailto(title: string, markdown: string): string {
  const body = markdown.length > MAX_MAILTO_BODY_CHARS
    ? markdown.slice(0, MAX_MAILTO_BODY_CHARS).trimEnd() + TRUNCATION_NOTICE
    : markdown
  return `mailto:?subject=${encodeURIComponent(title.trim() || 'Meeting notes')}&body=${encodeURIComponent(body)}`
}
