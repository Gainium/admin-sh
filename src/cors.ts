// CORS_ORIGIN is one value shared with the main-app api, so both accept the
// same list format: origins separated by commas and/or whitespace.
// A single origin stays a plain string, multiple become an array.
export function parseCorsOrigin(
  raw: string | undefined,
): string | string[] | undefined {
  const origins = (raw ?? '').split(/[\s,]+/).filter(Boolean)
  if (origins.length === 0) return undefined
  return origins.length === 1 ? origins[0] : origins
}
