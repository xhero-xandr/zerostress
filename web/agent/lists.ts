// Small lists the rules use. They are data, short on purpose and mostly English (spec 008, 9).

import { sld } from './domain.ts';

export interface Brand {
  /** names as they appear in a title or text */
  words: string[];
  /** the label before the suffix that belongs to the organisation: "amazon" for amazon.de and amazon.co.uk */
  slds: string[];
}

export const BRANDS: readonly Brand[] = [
  { words: ['paypal'], slds: ['paypal', 'paypalobjects'] },
  { words: ['microsoft', 'outlook', 'office 365', 'onedrive'], slds: ['microsoft', 'live', 'office', 'outlook', 'microsoftonline', 'office365', 'sharepoint', 'onedrive', 'msn', 'bing', 'azure', 'windows'] },
  { words: ['google', 'gmail'], slds: ['google', 'gmail', 'youtube', 'gstatic', 'googleusercontent', 'googleapis', 'goo'] },
  { words: ['apple id', 'icloud', 'apple'], slds: ['apple', 'icloud', 'mzstatic'] },
  { words: ['amazon'], slds: ['amazon', 'amazonaws', 'amzn', 'a2z'] },
  { words: ['facebook', 'instagram', 'whatsapp'], slds: ['facebook', 'fb', 'meta', 'instagram', 'whatsapp', 'fbcdn'] },
  { words: ['netflix'], slds: ['netflix', 'nflxso'] },
  { words: ['linkedin'], slds: ['linkedin', 'licdn'] },
  { words: ['dropbox'], slds: ['dropbox', 'dropboxusercontent'] },
  { words: ['docusign'], slds: ['docusign', 'docusign'] },
  { words: ['dhl'], slds: ['dhl'] },
  { words: ['fedex'], slds: ['fedex'] },
  { words: ['usps'], slds: ['usps'] },
  { words: ['binance'], slds: ['binance'] },
  { words: ['coinbase'], slds: ['coinbase'] },
  { words: ['chase'], slds: ['chase', 'jpmorgan'] },
  { words: ['bank of america'], slds: ['bankofamerica', 'bofa'] },
  { words: ['wells fargo'], slds: ['wellsfargo'] },
  { words: ['сбербанк', 'сбер', 'sberbank'], slds: ['sberbank', 'sber', 'sbrf', 'сбербанк'] },
  { words: ['тинькофф', 'tinkoff', 'т-банк'], slds: ['tinkoff', 'tbank', 'тинькофф'] },
  { words: ['госуслуги', 'gosuslugi'], slds: ['gosuslugi'] },
  { words: ['яндекс', 'yandex'], slds: ['yandex', 'ya', 'yastatic'] },
  { words: ['вконтакте', 'vkontakte'], slds: ['vk', 'vkontakte', 'userapi'] },
];

export function belongsTo(brand: Brand, host: string): boolean {
  return brand.slds.includes(sld(host));
}

/** Link shortening services: the first hop of a chain on one of them hides where it leads. */
export const SHORTENERS: ReadonlySet<string> = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'rebrand.ly', 'cutt.ly', 'shorturl.at', 'tiny.cc',
  'rb.gy', 'lnkd.in', 't.ly', 'v.gd', 's.id', 'clck.ru', 'vk.cc', 'qr.net', 'bl.ink', 'shorte.st', 'adf.ly',
]);

/** Files a person must not be tricked into running, and documents that carry macros. */
export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe', 'msi', 'scr', 'bat', 'cmd', 'com', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'jar', 'apk', 'dmg', 'pkg',
  'iso', 'img', 'lnk', 'hta', 'dll', 'sh', 'run', 'appimage', 'deb', 'rpm', 'docm', 'xlsm', 'pptm', 'xlam', 'dotm', 'reg', 'cpl',
]);

export const LOGIN_WORDS = /\b(?:sign[ -]?in|log[ -]?in|login|verify|verification|confirm your|account|password|secure|update (?:your )?(?:payment|billing|card))\b|вход|войти|пароль|аккаунт|подтвердите|авторизац/iu;
