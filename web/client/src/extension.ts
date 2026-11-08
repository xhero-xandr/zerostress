// Our browser extension, under two origins (see EXTENSION_ORIGINS in web/server/app.ts for why): the Chrome Web
// Store's own id, and the one fixed by the public key in web/extension/public/manifest.json (the GitHub release and
// an unpacked load). The agent panel (/panel) takes links only from a page of one of these origins that frames it;
// the server lets only these origins frame /panel.
export const EXTENSION_ORIGINS = [
  'chrome-extension://jbfpfekapmgpjjbiigjkhahongcjdlpm',
  'chrome-extension://eanjmnmjjbbcpgnhdifdpmednecllbbc',
];
