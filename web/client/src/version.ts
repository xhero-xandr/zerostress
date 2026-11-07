// The version of this build, set at build time from VERSION and git (deploy/release.sh describe): X.Y.Z on a release,
// X.Y.Z+N.gHASH after it. The extension the site offers is the one of its own release, never "the latest".
declare const __ZS_VERSION__: string | undefined;

export const BUILD: string = typeof __ZS_VERSION__ === 'string' && /^\d+\.\d+\.\d+(\+[0-9A-Za-z.]+)?$/.test(__ZS_VERSION__) ? __ZS_VERSION__ : '0.0.0+unknown';
/** the release this build belongs to (the part before "+") */
export const RELEASE: string = BUILD.split('+')[0]!;
export const REPO = 'https://github.com/xhero-xandr/zerostress';
export const releasePage = (v: string = RELEASE): string => `${REPO}/releases/tag/v${v}`;
export const extensionZip = (v: string = RELEASE): string => `${REPO}/releases/download/v${v}/zerostress-extension-${v}.zip`;
