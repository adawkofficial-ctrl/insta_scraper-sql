import React from "react";

export type BadgeVariant =
  | "primary"
  | "default"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  dot?: boolean;
}

const variantStyles: Record<BadgeVariant, { badge: string; dot: string }> = {
  primary: {
    badge: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20",
    dot: "bg-indigo-500",
  },
  default: {
    badge: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 border-indigo-500/20",
    dot: "bg-indigo-500",
  },
  success: {
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    dot: "bg-emerald-500",
  },
  warning: {
    badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    dot: "bg-amber-500",
  },
  danger: {
    badge: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20",
    dot: "bg-rose-500",
  },
  info: {
    badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
    dot: "bg-sky-500",
  },
  neutral: {
    badge: "bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20",
    dot: "bg-slate-400",
  },
};

export function Badge({
  variant = "default",
  dot = false,
  className = "",
  children,
  ...props
}: BadgeProps) {
  const styles = variantStyles[variant] || variantStyles.default;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium border transition-colors ${styles.badge} ${className}`.trim()}
      {...props}
    >
      {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${styles.dot}`} />}
      {children}
    </span>
  );
}
