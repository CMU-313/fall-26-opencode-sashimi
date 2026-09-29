import { expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

test("truncate leaves short strings untouched", () => {
  expect(Locale.truncate("hello", 80)).toBe("hello")
})

test("truncate cuts plain text at the requested length", () => {
  expect(Locale.truncate("a".repeat(10), 5)).toBe("aaaa…")
})

test("truncate does not split a multi-codepoint emoji in half", () => {
  // Family emoji (man + woman + girl + boy joined by ZWJ) is one grapheme
  // but several UTF-16 code units; a naive `.slice()` would cut it mid-sequence.
  const family = "👨‍👩‍👧‍👦"
  const text = `${family} is one grapheme cluster`
  const result = Locale.truncate(text, family.length + 1)
  // The full emoji sequence must survive intact, not a mangled partial surrogate.
  expect(result.startsWith(family)).toBe(true)
  expect(result.endsWith("…")).toBe(true)
})
