/**
 * Re-export Bun's fetch-related types as globals so test files can use
 * HeadersInit / BodyInit without importing from "bun".
 */
type HeadersInit = Bun.HeadersInit;
type BodyInit = Bun.BodyInit;
