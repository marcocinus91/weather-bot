const SPECIAL_CHARS = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(SPECIAL_CHARS, (c) => `\\${c}`);
}
