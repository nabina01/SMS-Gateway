const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegistrationInput(body = {}) {
  const errors = [];
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!name) {
    errors.push("Name is required");
  } else if (name.length > 100) {
    errors.push("Name must be 100 characters or fewer");
  }

  if (!email) {
    errors.push("Email is required");
  } else if (email.length > 255 || !EMAIL_REGEX.test(email)) {
    errors.push("Email must be a valid email address");
  }

  if (!password) {
    errors.push("Password is required");
  } else if (password.length < 8 || password.length > 72) {
    errors.push("Password must be between 8 and 72 characters");
  }

  return { name, email, password, errors };
}

export function validateLoginInput(body = {}) {
  const errors = [];
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email) errors.push("Email is required");
  if (!password) errors.push("Password is required");

  return { email, password, errors };
}
