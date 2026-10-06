// Settings a deployment can change without rebuilding: public/config.js
// (config.js in a build) sets window.OPCODE_CONFIG before the app starts.
export const siteConfig = globalThis.OPCODE_CONFIG ?? {}
