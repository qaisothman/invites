import { ValidateBy, ValidationOptions } from 'class-validator';

// A display name travels in pushes and in invitation emails sent from our own
// domain, so it is held to this:
//
// - No control character and no line or paragraph separator: no header
//   tricks, no extra lines.
// - No invisible character that reorders or hides text: the bidi controls
//   (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069), the
//   zero-width space and word joiner (U+200B, U+2060), the invisible
//   operators and deprecated format controls (U+2061 to U+2064, U+206A to
//   U+206F), the byte order mark (U+FEFF) and interlinear annotations
//   (U+FFF9 to U+FFFB). Every other format character is allowed, such as the
//   zero-width joiner and non-joiner that emoji and Persian names need, and
//   the tag characters of flag emoji.
// - No link: an http: or https: scheme, www., or a domain followed by a path
//   (evil.example/unlock). Looked for after NFKC normalisation and with
//   invisible characters removed, so full-width and other look-alike forms
//   count too. A bare domain (evil.example) passes: it can't be told apart
//   from a dotted name (J.Smith, St.John).
export const UNSAFE_TEXT =
  /[\p{Cc}\p{Zl}\p{Zp}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/u;
const LINK =
  /https?:|www\.|(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?[.\u3002])+\p{L}[\p{L}\p{N}-]*[\p{L}\p{N}](?::\d+)?\//iu;

export const DISPLAY_NAME_MESSAGE =
  "displayName can't contain links, control characters, line breaks or characters that hide or reorder text";

export function isSafeDisplayName(name: string): boolean {
  if (UNSAFE_TEXT.test(name)) return false;
  const plain = name
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  return !LINK.test(plain);
}

export function IsDisplayName(options?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isDisplayName',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isSafeDisplayName(value),
        defaultMessage: () => DISPLAY_NAME_MESSAGE,
      },
    },
    options,
  );
}
