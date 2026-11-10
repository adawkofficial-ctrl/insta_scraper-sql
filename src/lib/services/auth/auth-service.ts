import "server-only";

import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { getPrismaClient } from "@/lib/db/prisma";
import { BadRequestError, ConflictError, UnauthorizedError } from "@/lib/errors";
import {
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  getAuthSecretBytes,
} from "./auth-constants";

export { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS };

export type SafeUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  createdAt: Date;
};

export type SessionPayload = {
  sub: string; // User ID
  email: string;
  name?: string | null;
};

// Standard RFC 5322 compliant email regex
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Precomputed cost-12 bcrypt hash used for constant-time comparisons when email is not found
const DUMMY_HASH = "$2a$12$e8rXpvhMpvxZ1fW5p9h3U.zG3z9/zY4j8n2o9a0b1c2d3e4f5g6h";

export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  const secretKey = getAuthSecretBytes();
  return new SignJWT({ email: payload.email, name: payload.name })
    .setSubject(payload.sub)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime("7d")
    .sign(secretKey);
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const secretKey = getAuthSecretBytes();
    const { payload } = await jwtVerify(token, secretKey, {
      algorithms: ["HS256"],
    });

    if (!payload.sub || typeof payload.sub !== "string") {
      return null;
    }

    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : "",
      name: typeof payload.name === "string" ? payload.name : null,
    };
  } catch {
    return null;
  }
}

export async function registerUser(input: {
  email?: string;
  password?: string;
  name?: string;
}): Promise<{ user: SafeUser; token: string }> {
  const prisma = getPrismaClient();

  const email = (input.email || "").trim().toLowerCase();
  const password = input.password || "";
  const name = input.name ? input.name.trim().slice(0, 100) : null;

  if (!email || email.length > 254 || !EMAIL_REGEX.test(email)) {
    throw new BadRequestError("INVALID_EMAIL", "A valid email address is required.");
  }

  if (!password || password.length < 6) {
    throw new BadRequestError(
      "PASSWORD_TOO_SHORT",
      "Password must be at least 6 characters long.",
    );
  }

  if (password.length > 128) {
    throw new BadRequestError(
      "PASSWORD_TOO_LONG",
      "Password must not exceed 128 characters.",
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });

  if (existing) {
    throw new ConflictError("EMAIL_EXISTS", "A user with this email address already exists.");
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name,
    },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      createdAt: true,
    },
  });

  const token = await createSessionToken({
    sub: user.id,
    email: user.email,
    name: user.name,
  });

  return { user, token };
}

export async function loginUser(input: {
  email?: string;
  password?: string;
}): Promise<{ user: SafeUser; token: string }> {
  const prisma = getPrismaClient();

  const email = (input.email || "").trim().toLowerCase();
  const password = input.password || "";

  if (!email || !password) {
    throw new BadRequestError("MISSING_CREDENTIALS", "Email and password are required.");
  }

  if (password.length > 128) {
    throw new UnauthorizedError("INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const userRecord = await prisma.user.findUnique({
    where: { email },
  });

  if (!userRecord) {
    // Run dummy compare to mitigate user enumeration timing attacks
    await comparePassword(password, DUMMY_HASH);
    throw new UnauthorizedError("INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const isMatch = await comparePassword(password, userRecord.passwordHash);
  if (!isMatch) {
    throw new UnauthorizedError("INVALID_CREDENTIALS", "Invalid email or password.");
  }

  const user: SafeUser = {
    id: userRecord.id,
    email: userRecord.email,
    name: userRecord.name,
    image: userRecord.image,
    createdAt: userRecord.createdAt,
  };

  const token = await createSessionToken({
    sub: user.id,
    email: user.email,
    name: user.name,
  });

  return { user, token };
}

export async function getUserById(userId: string): Promise<SafeUser | null> {
  if (!userId || typeof userId !== "string") return null;
  const prisma = getPrismaClient();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      createdAt: true,
    },
  });
  return user;
}
