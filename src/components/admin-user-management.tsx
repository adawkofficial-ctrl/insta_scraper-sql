"use client";

export type AdminManagedUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  image: string | null;
  createdAt: string;
};

export function AdminUserManagement(_props?: { currentRole?: string }) {
  return null;
}
