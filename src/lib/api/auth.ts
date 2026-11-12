import { apiFetch } from "./client";

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  role?: string;
  createdAt: string;
};

export async function getMe(): Promise<{ user: AuthUser | null }> {
  try {
    const data = await apiFetch<AuthUser | { user: AuthUser }>("/api/auth/me");
    if (data && "user" in data) {
      return { user: data.user };
    }
    return { user: (data as AuthUser) || null };
  } catch {
    return { user: null };
  }
}

export async function loginUser(credentials: {
  email: string;
  password: string;
}): Promise<{ user: AuthUser }> {
  return apiFetch<{ user: AuthUser }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
}

export async function registerUser(data: {
  email: string;
  password: string;
  name?: string;
}): Promise<{ user: AuthUser }> {
  return apiFetch<{ user: AuthUser }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function logoutUser(): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>("/api/auth/logout", {
    method: "POST",
  });
}
