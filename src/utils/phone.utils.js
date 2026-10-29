const NEPALI_MOBILE_REGEX = /^(97|98)\d{8}$/;
export function normalizeNepaliPhone(phone) {
  if (typeof phone !== "string") {
    throw new Error("Phone number must be a string");
  }

  let normalized = phone.trim();

  if (!normalized) {
    throw new Error("Phone number must not be empty");
  }
  normalized = normalized.replace(/[\s\-()]/g, "");

  if (normalized.startsWith("+977")) {
    normalized = normalized.slice(4);
  } else if (normalized.startsWith("977")) {
    normalized = normalized.slice(3);
  }

  if (!NEPALI_MOBILE_REGEX.test(normalized)) {
    throw new Error(
      "Invalid Nepali mobile number. Use a 10-digit number starting with 97 or 98."
    );
  }

  return normalized;
}

export function isValidNepaliPhone(phone) {
  try {
    normalizeNepaliPhone(phone);
    return true;
  } catch {
    return false;
  }
}
