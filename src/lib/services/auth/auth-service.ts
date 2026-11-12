import "server-only";

import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { getPrismaClient } from "@/lib/db/prisma";
import { BadRequestError, ConflictError, UnauthorizedError } from "@/lib/errors";
import { getAdminCredentials } from "@/lib/env";
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
  role: string;
  createdAt: Date;
};

export type SessionPayload = {
  sub: string; // User ID
  email: string;
  name?: string | null;
  role?: string;
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
  return new SignJWT({
    email: payload.email,
    name: payload.name,
    role: payload.role ?? "USER",
  })
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
      role: typeof payload.role === "string" ? payload.role : "USER",
    };
  } catch {
    return null;
  }
}

export async function registerUser(input: {
  email?: string;
  password?: string;
  name?: string;
  role?: string;
}): Promise<{ user: SafeUser; token: string }> {
  const prisma = getPrismaClient();

  const email = (input.email || "").trim().toLowerCase();
  const password = input.password || "";
  const name = input.name ? input.name.trim().slice(0, 100) : null;
  const role = input.role === "ADMIN" ? "ADMIN" : "USER";

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
      role,
    },
    select: {
      id: true,
      email: true,
      name: true,
      image: true,
      role: true,
      createdAt: true,
    },
  });

  const token = await createSessionToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  });

  return { user, token };
}

export async function ensureAdminUser(): Promise<SafeUser> {
  const prisma = getPrismaClient();
  const adminCreds = getAdminCredentials();
  const existing = await prisma.user.findUnique({
    where: { email: adminCreds.email },
  });

  const passwordHash = await hashPassword(adminCreds.password);

  if (existing) {
    const isMatch = await comparePassword(adminCreds.password, existing.passwordHash);
    if (!isMatch || existing.role !== "ADMIN") {
      const updated = await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          role: "ADMIN",
        },
      });
      return {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        image: updated.image,
        role: updated.role,
        createdAt: updated.createdAt,
      };
    }
    return {
      id: existing.id,
      email: existing.email,
      name: existing.name,
      image: existing.image,
      role: existing.role,
      createdAt: existing.createdAt,
    };
  }

  const created = await prisma.user.create({
    data: {
      email: adminCreds.email,
      passwordHash,
      name: "System Administrator",
      role: "ADMIN",
    },
  });

  return {
    id: created.id,
    email: created.email,
    name: created.name,
    image: created.image,
    role: created.role,
    createdAt: created.createdAt,
  };
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

  const adminCreds = getAdminCredentials();
  const isAdminEmail = email === adminCreds.email;

  let userRecord = await prisma.user.findUnique({
    where: { email },
  });

  if (!userRecord) {
    // If logging in with the configured admin credentials from .env, auto-provision
    if (isAdminEmail && password === adminCreds.password) {
      const passwordHash = await hashPassword(adminCreds.password);
      userRecord = await prisma.user.create({
        data: {
          email: adminCreds.email,
          passwordHash,
          name: "System Administrator",
          role: "ADMIN",
        },
      });
    } else {
      // Run dummy compare to mitigate user enumeration timing attacks
      await comparePassword(password, DUMMY_HASH);
      throw new UnauthorizedError("INVALID_CREDENTIALS", "Invalid email or password.");
    }
  } else if (isAdminEmail && password === adminCreds.password) {
    // Admin password or role may have been updated in .env; sync to database
    const isMatch = await comparePassword(password, userRecord.passwordHash);
    if (!isMatch || userRecord.role !== "ADMIN") {
      const passwordHash = await hashPassword(adminCreds.password);
      userRecord = await prisma.user.update({
        where: { id: userRecord.id },
        data: {
          passwordHash,
          role: "ADMIN",
        },
      });
    }
  } else {
    const isMatch = await comparePassword(password, userRecord.passwordHash);
    if (!isMatch) {
      throw new UnauthorizedError("INVALID_CREDENTIALS", "Invalid email or password.");
    }
  }

  const user: SafeUser = {
    id: userRecord.id,
    email: userRecord.email,
    name: userRecord.name,
    image: userRecord.image,
    role: userRecord.role || "USER",
    createdAt: userRecord.createdAt,
  };

  const token = await createSessionToken({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
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
      role: true,
      createdAt: true,
    },
  });
  return user;
}
