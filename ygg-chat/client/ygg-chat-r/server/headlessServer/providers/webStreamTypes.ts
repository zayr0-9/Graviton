// server/headlessServer/providers/webStreamTypes.ts
//
// Structural stand-in for the web-streams read result. The server graph
// typechecks without DOM libs (server/tsconfig.json), while the Electron host
// program (electron/tsconfig.json) pulls DOM globals in through the electron
// package types. The DOM lib and @types/node's stream/web disagree on the
// done-result shape (`value?: undefined` vs required `value: T | undefined`),
// so importing either concrete type breaks the other program. This shape is
// assignable from both, so reader.read() results flow into it under each.
export type ReadableStreamReadResult<T> = { done: false; value: T } | { done: true; value?: T | undefined }
