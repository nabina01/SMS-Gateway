// GSM 03.38 default alphabet. Characters are written as escapes where they are
// not printable ASCII so the source file stays encoding-independent.
const GSM7_BASIC = new Set([
  "@", "\u00A3", "$", "\u00A5", "\u00E8", "\u00E9", "\u00F9", "\u00EC",
  "\u00F2", "\u00C7", "\n", "\u00D8", "\u00F8", "\r", "\u00C5", "\u00E5",
  "\u0394", "_", "\u03A6", "\u0393", "\u039B", "\u03A9", "\u03A0", "\u03A8",
  "\u03A3", "\u0398", "\u039E", "\u00C6", "\u00E6", "\u00DF", "\u00C9",
  " ", "!", "\"", "#", "\u00A4", "%", "&", "'", "(", ")", "*", "+", ",",
  "-", ".", "/", ":", ";", "<", "=", ">", "?", "\u00A1",
  "\u00C4", "\u00D6", "\u00D1", "\u00DC", "\u00A7", "\u00BF",
  "\u00E4", "\u00F6", "\u00F1", "\u00FC", "\u00E0",
]);
for (const character of "0123456789") GSM7_BASIC.add(character);
for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") GSM7_BASIC.add(character);
for (const character of "abcdefghijklmnopqrstuvwxyz") GSM7_BASIC.add(character);

// GSM extension table. Each extension character occupies two septets.
const GSM7_EXTENSION = new Set([
  "\f", "^", "{", "}", "\\", "[", "~", "]", "|", "\u20AC",
]);

function isGsm7(message) {
  for (const character of message) {
    if (!GSM7_BASIC.has(character) && !GSM7_EXTENSION.has(character)) {
      return false;
    }
  }
  return true;
}

/**
 * Count SMS parts using the assignment's shared rules:
 * GSM-7: 160 units single-part, 153 units per multipart part.
 * Unicode: 70 characters single-part, 67 characters per multipart part.
 * Extension-table characters count as two GSM-7 units.
 */
export function calculateSmsParts(message) {
  if (typeof message !== "string" || message.length === 0) {
    throw new Error("Message must be a non-empty string");
  }

  const gsm = isGsm7(message);
  const characters = [...message].length;

  const units = gsm
    ? [...message].reduce(
        (total, character) =>
          total + (GSM7_EXTENSION.has(character) ? 2 : 1),
        0
      )
    : characters;

  const singleLimit = gsm ? 160 : 70;
  const multipartLimit = gsm ? 153 : 67;

  return {
    encoding: gsm ? "GSM-7" : "Unicode",
    characters,
    units,
    parts: units <= singleLimit ? 1 : Math.ceil(units / multipartLimit),
  };
}

export { GSM7_BASIC, GSM7_EXTENSION };
