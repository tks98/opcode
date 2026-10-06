// Settings for this copy of Opcode, read before the app starts. In a deployed
// build, edit dist/config.js to change them without rebuilding. The Docker
// image's server (scripts/server.mjs) writes this file from its environment.
// They take precedence over the ones the build was made with (VITE_WISP_URL,
// VITE_PREVIEW_HOST).
window.OPCODE_CONFIG = {
  // The internet relay for terminals and Linux machines: a wss:// address,
  // a path on this site such as '/wisp/', or '' for none (docs/deploying.md:
  // "Internet relay").
  // relay: 'wss://relay.example.com/',
  //
  // The web preview's host: https://preview.example.com/, or
  // https://*.preview.example.com/ for one address per server (docs/deploying.md:
  // "Web preview host").
  // previewHost: 'https://*.preview.example.com/',
}
