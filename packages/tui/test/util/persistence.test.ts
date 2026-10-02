import { expect, test } from "bun:test"
import { isMissingFileError } from "../../src/util/persistence"

test("a file-not-found error (ENOENT) is a missing file", () => {
  const error = Object.assign(new Error("no such file"), { code: "ENOENT" })
  expect(isMissingFileError(error)).toBe(true)
})

test("a permission error (EACCES) is not a missing file", () => {
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" })
  expect(isMissingFileError(error)).toBe(false)
})

test("a JSON parse failure (no error code at all) is not a missing file", () => {
  // This is what a corrupted/malformed bookmark.json actually produces:
  // JSON.parse throws a plain SyntaxError with no `code` property.
  const error = new SyntaxError("Unexpected token in JSON")
  expect(isMissingFileError(error)).toBe(false)
})

test("a non-error thrown value is not treated as a missing file", () => {
  expect(isMissingFileError("something went wrong")).toBe(false)
  expect(isMissingFileError(undefined)).toBe(false)
})
