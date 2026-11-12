import { NextResponse } from "next/server";
import { getPrismaClient } from "@/lib/db/prisma";
import { registerUser, requireAdmin } from "@/lib/services/auth";
import { apiError, handleRouteError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const prisma = getPrismaClient();

    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        image: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json({ users });
  } catch (error) {
    return handleRouteError(request, error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
    }

    const { email, password, name, role } = (body && typeof body === "object" ? body : {}) as {
      email?: string;
      password?: string;
      name?: string;
      role?: string;
    };

    if (!email || !password) {
      return apiError(400, "MISSING_FIELDS", "Email and password are required.");
    }

    const { user } = await registerUser({
      email,
      password,
      name,
      role: role === "ADMIN" ? "ADMIN" : "USER",
    });

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return handleRouteError(request, error);
  }
}
