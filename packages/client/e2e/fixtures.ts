// Test Plan §7.1's DOM-01 fixture strings — one per Unicode edge case named there.
export const DOM01_FIXTURES: ReadonlyArray<readonly [name: string, text: string]> = [
  ["pure ASCII", "hello world"],
  ["BMP with diacritics", "héllo wörld"],
  ["one astral char", "hello 👋 world"],
  ["ZWJ family emoji", "👨‍👩‍👧‍👦 family"],
  ["regional indicator flags", "🇫🇷🇯🇵 flags"],
  ["Devanagari with matras", "मैं हिन्दी बोलता हूँ"],
  ["Hangul", "한글 조합"],
];
