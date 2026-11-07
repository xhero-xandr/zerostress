// The version of this build, set at build time from VERSION and git (deploy/release.sh describe): X.Y.Z on a release,
// X.Y.Z+N.gHASH after it, X.Y.Z-dev+… on the way to it. The extension the site offers is the one of its release (the
// X.Y.Z of VERSION), never "the latest".
declare const __ZS_VERSION__: string | undefined;

export const BUILD: string = typeof __ZS_VERSION__ === 'string' && /^\d+\.\d+\.\d+(-dev)?(\+[0-9A-Za-z.]+)?$/.test(__ZS_VERSION__) ? __ZS_VERSION__ : '0.0.0+unknown';
/** the release this build belongs to: X.Y.Z, without "-dev" and "+…" */
export const RELEASE: string = BUILD.replace(/[-+].*$/, '');
export const REPO = 'https://github.com/xhero-xandr/zerostress';
export const releasePage = (v: string = RELEASE): string => `${REPO}/releases/tag/v${v}`;
export const extensionZip = (v: string = RELEASE): string => `${REPO}/releases/download/v${v}/zerostress-extension-${v}.zip`;
