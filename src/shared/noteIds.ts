/** Portable single-file note IDs, also used for untrusted cloud document IDs. */
export function isValidNoteId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 4 && id.length <= 255
    && !id.includes('..') && !/[<>:"/\\|?*\u0000-\u001f]/.test(id)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(id)
    && id.toLowerCase().endsWith('.txt')
}
