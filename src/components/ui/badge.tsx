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
    badge: "bg-orange-500/12 text-orange-300 border-orange-500/30",
    dot: "bg-orange-500",
  },
  default: {
    badge: "bg-orange-500/12 text-orange-300 border-orange-500/30",
    dot: "bg-orange-500",
  },
  success: {
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    dot: "bg-emerald-500",
  },
  warning: {
    badge: "bg-yellow-400/10 text-yellow-300 border-yellow-400/25",
    dot: "bg-yellow-400",
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
    badge: "bg-white/5 text-zinc-300 border-white/10",
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
