/** The value expected after this draft's last valid local commit. A different
 * external value (undo, reload or the second editor) invalidates its text. */
export interface NumberDraft {
  text: string;
  value: number;
}

export function parseNumberText(text: string): number | null {
  // Keep empty text, signs and unfinished exponents as local drafts. Number()
  // alone would turn an empty input into an unintended zero commit.
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

export function currentNumberDraft(draft: NumberDraft | null, value: number): NumberDraft | null {
  return draft?.value === value ? draft : null;
}
