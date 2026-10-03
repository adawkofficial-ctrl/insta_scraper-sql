import "server-only";

import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { getPrismaClient } from "@/lib/db/prisma";
import { BadRequestError, ConflictError, UnauthorizedError } from "@/lib/errors";

export const SESSION_COOKIE_NAME = "insta_session";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
};

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

function getSecretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  // Fail closed in production: never sign sessions with a published default key.
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "AUTH_SECRET must be configured (at least 32 characters) in production.",
      );
    }
  }
  return new TextEncoder().encode(
    secret || "insta_scraper_default_super_secret_signing_key_32_chars",
  );
}

export async function hashPassword(password: string): Promise<string> {
  const saltRounds = 12;
  return bcrypt.hash(password, saltRounds);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  const secret = getSecretKey();
  return new SignJWT({ email: payload.email, name: payload.name })
    .setSubject(payload.sub)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const secret = getSecretKey();
    const { payload } = await jwtVerify(token, secret, {
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
  const name = input.name ? input.name.trim() : null;

  if (!email || !email.includes("@") || !email.includes(".")) {
    throw new BadRequestError("INVALID_EMAIL", "A valid email address is required.");
  }

  if (!password || password.length < 6) {
    throw new BadRequestError(
      "PASSWORD_TOO_SHORT",
      "Password must be at least 6 characters long.",
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

  const userRecord = await prisma.user.findUnique({
    where: { email },
  });

  if (!userRecord) {
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
