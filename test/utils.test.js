import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isValidNepaliPhone, normalizeNepaliPhone } from "../src/utils/phone.utils.js";
import { calculateSmsParts } from "../src/utils/sms.utils.js";

describe("Phone Utilities", () => {
  it("normalizes a standard 10-digit Nepali number starting with 98", () => {
    assert.equal(normalizeNepaliPhone("9841234567"), "9841234567");
  });

  it("normalizes a standard 10-digit Nepali number starting with 97", () => {
    assert.equal(normalizeNepaliPhone("9741234567"), "9741234567");
  });

  it("removes +977 country code prefix", () => {
    assert.equal(normalizeNepaliPhone("+9779841234567"), "9841234567");
    assert.equal(normalizeNepaliPhone("+977 9841234567"), "9841234567");
  });

  it("removes 977 country code prefix without plus", () => {
    assert.equal(normalizeNepaliPhone("9779841234567"), "9841234567");
  });

  it("strips whitespace and hyphens within the number", () => {
    assert.equal(normalizeNepaliPhone("984-123-4567"), "9841234567");
    assert.equal(normalizeNepaliPhone("  984 123 4567  "), "9841234567");
  });

  it("throws for invalid Nepali prefixes (e.g., 96, 91)", () => {
    assert.throws(
      () => normalizeNepaliPhone("9641234567"),
      /Invalid Nepali mobile number/
    );
    assert.throws(
      () => normalizeNepaliPhone("9141234567"),
      /Invalid Nepali mobile number/
    );
  });

  it("throws for incorrect digit counts", () => {
    assert.throws(() => normalizeNepaliPhone("984123456"), /Invalid Nepali mobile number/);
    assert.throws(() => normalizeNepaliPhone("98412345678"), /Invalid Nepali mobile number/);
  });

  it("throws for non-string input", () => {
    assert.throws(() => normalizeNepaliPhone(9841234567), /Phone number must be a string/);
    assert.throws(() => normalizeNepaliPhone(null), /Phone number must be a string/);
  });

  it("accepts prefix plus common separators and parentheses", () => {
    assert.equal(normalizeNepaliPhone("+977-984-123-4567"), "9841234567");
    assert.equal(normalizeNepaliPhone("(+977) 9801122334"), "9801122334");
    assert.equal(normalizeNepaliPhone("977 9761234567"), "9761234567");
    assert.equal(isValidNepaliPhone("9812345678"), true);
    assert.equal(isValidNepaliPhone("009779841234567"), false);
  });
});

describe("SMS Part Calculation Utilities", () => {
  it("calculates 1 part for GSM-7 message with <= 160 characters", () => {
    const msg = "A".repeat(160);
    const result = calculateSmsParts(msg);
    assert.equal(result.encoding, "GSM-7");
    assert.equal(result.units, 160);
    assert.equal(result.parts, 1);
  });

  it("calculates 2 parts for GSM-7 message with 161 characters", () => {
    const msg = "A".repeat(161);
    const result = calculateSmsParts(msg);
    assert.equal(result.encoding, "GSM-7");
    assert.equal(result.units, 161);
    // 161 / 153 = ceil(1.05) = 2
    assert.equal(result.parts, 2);
  });

  it("calculates 3 parts for GSM-7 message with 307 characters", () => {
    // 153 * 2 = 306, 307 needs 3 parts
    const msg = "A".repeat(307);
    const result = calculateSmsParts(msg);
    assert.equal(result.encoding, "GSM-7");
    assert.equal(result.parts, 3);
  });

  it("counts GSM-7 extension characters as 2 units", () => {
    // Standard char + extension char '|' (takes 2 units)
    const msg = "A|B"; // 2 basic + 1 extension = 4 units
    const result = calculateSmsParts(msg);
    assert.equal(result.encoding, "GSM-7");
    assert.equal(result.characters, 3);
    assert.equal(result.units, 4);
    assert.equal(result.parts, 1);
  });

  it("calculates 1 part for Unicode message <= 70 characters", () => {
    const msg = "नमस्ते संसार"; // Nepali unicode
    const result = calculateSmsParts(msg);
    assert.equal(result.encoding, "Unicode");
    assert.equal(result.parts, 1);
  });

  it("calculates 2 parts for Unicode message with 71 characters", () => {
    const msg = "न".repeat(71);
    const result = calculateSmsParts(msg);
    assert.equal(result.encoding, "Unicode");
    assert.equal(result.characters, 71);
    // 71 / 67 = ceil(1.059) = 2
    assert.equal(result.parts, 2);
  });

  it("calculates 3 parts for Unicode message with 135 characters", () => {
    // 67 * 2 = 134, 135 needs 3 parts
    const msg = "😊".repeat(135);
    const result = calculateSmsParts(msg);
    assert.equal(result.encoding, "Unicode");
    assert.equal(result.parts, 3);
  });

  it("matches the assignment examples: 200 English characters = 2 parts", () => {
    const result = calculateSmsParts("A".repeat(200));
    assert.equal(result.encoding, "GSM-7");
    assert.equal(result.parts, 2);
  });

  it("matches the assignment examples: 100 Nepali characters = 2 parts", () => {
    const result = calculateSmsParts("\u0928".repeat(100));
    assert.equal(result.encoding, "Unicode");
    assert.equal(result.parts, 2);
  });

  it("treats one emoji as Unicode and counts extension characters as two units", () => {
    const emoji = calculateSmsParts("Hello \u{1F600}");
    assert.equal(emoji.encoding, "Unicode");
    assert.equal(emoji.parts, 1);

    const euro = calculateSmsParts("\u20AC".repeat(80));
    assert.equal(euro.encoding, "GSM-7");
    assert.equal(euro.units, 160);
    assert.equal(euro.parts, 1);
  });

  it("throws for non-string or empty message", () => {
    assert.throws(() => calculateSmsParts(""), /non-empty string/);
    assert.throws(() => calculateSmsParts(null), /non-empty string/);
  });
});
