import { Suspense } from "react";
import { AuthCard } from "@/components/auth-card";

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 text-zinc-400">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-rose-500 border-t-transparent" />
        </div>
      }
    >
      <AuthCard initialMode="register" />
    </Suspense>
  );
}
