// Fetch API types available at runtime in Node.js 18+ but not declared by @types/node@20.
// These are used by the generated OpenAPI client.
type BodyInit = ReadableStream | XMLHttpRequestBodyInit;
type XMLHttpRequestBodyInit = Blob | BufferSource | FormData | URLSearchParams | string;
