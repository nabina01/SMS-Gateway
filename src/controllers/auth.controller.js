import { loginUser, registerUser } from "../services/auth.service.js";
import {
  validateLoginInput,
  validateRegistrationInput,
} from "../utils/validation.js";

export async function register(req, res, next) {
  try {
    const { name, email, password, errors } = validateRegistrationInput(
      req.body || {}
    );

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid registration payload",
        errors,
      });
    }

    const result = await registerUser({ name, email, password });

    return res.status(201).json({
      success: true,
      message: "Registration successful",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function login(req, res, next) {
  try {
    const { email, password, errors } = validateLoginInput(req.body || {});

    if (errors.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid login payload",
        errors,
      });
    }

    const result = await loginUser({ email, password });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
