/** Provider query discrimination shared by turn adapters and reflection. */
export function isAsyncGenerator<T = unknown>(value: unknown): value is AsyncGenerator<T> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}
