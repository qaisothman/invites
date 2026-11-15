import { isSafeDisplayName } from './display-name';

describe('isSafeDisplayName', () => {
  it.each([
    ['a plain name', 'Ada Lovelace'],
    ['dotted names', 'J.Smith'],
    ['a dotted name with a space', 'St.John Rivers'],
    [
      'an emoji joined with a zero-width joiner',
      'Sara \u{1F469}\u200D\u{1F4BB}',
    ],
    [
      'a Persian name with a zero-width non-joiner',
      '\u0639\u0644\u06CC\u200C\u0631\u0636\u0627',
    ],
    [
      'a flag made of tag characters',
      'Ewan \u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
    ],
    ['full-width letters', '\uFF21\uFF44\uFF41'],
    ['a bare domain', 'evil.example'],
  ])('accepts %s', (_, name) => {
    expect(isSafeDisplayName(name)).toBe(true);
  });

  it.each([
    ['an https link', 'Your account is locked, visit https://evil.example'],
    ['an http link', 'Ada http://evil.example'],
    ['a www link', 'www.evil.example'],
    ['a domain with a path', 'Unlock at evil-example.com/unlock'],
    ['a domain with a port and a path', 'evil.example:8080/x'],
    [
      'a full-width scheme',
      'Ada \uFF48\uFF54\uFF54\uFF50\uFF53\uFF1A//evil.example',
    ],
    ['a full-width www', '\uFF57\uFF57\uFF57\uFF0Eevil.example'],
    [
      'a domain with a full-width dot and slash',
      'evil\uFF0Eexample\uFF0Funlock',
    ],
    ['a scheme split by a zero-width joiner', 'ht\u200Dtps://evil.example'],
    ['a right-to-left override', 'Ada \u202Egnp.exe'],
    ['a bidi isolate', 'Ada \u2066x\u2069'],
    ['a left-to-right mark', 'Ada\u200E'],
    ['a right-to-left mark', 'Ada\u200F'],
    ['an Arabic letter mark', 'Ada\u061C'],
    ['a zero-width space', 'Ad\u200Ba'],
    ['a byte order mark', '\uFEFFAda'],
    ['a line break', 'Ada\r\nBcc: everyone@example.com'],
    ['a paragraph separator', 'Ada\u2029Lovelace'],
    ['a control character', 'Ada\u0007'],
  ])('refuses %s', (_, name) => {
    expect(isSafeDisplayName(name)).toBe(false);
  });
});
