import React, { forwardRef } from "react";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "subtle-danger";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-brand-gradient text-white font-semibold border border-orange-400/40 shadow-[0_6px_20px_-8px_rgba(255,122,26,0.7)] hover:brightness-110 hover:shadow-[0_8px_26px_-8px_rgba(255,122,26,0.85)] active:brightness-95 focus-visible:ring-2 focus-visible:ring-orange-500/60",
  secondary:
    "bg-white text-black font-semibold border border-white hover:bg-zinc-200 active:bg-zinc-300 shadow-card focus-visible:ring-2 focus-visible:ring-white/40",
  outline:
    "bg-transparent hover:bg-orange-500/10 active:bg-orange-500/15 text-secondary hover:text-orange-300 border border-default hover:border-orange-500/50 focus-visible:ring-2 focus-visible:ring-orange-500/30",
  ghost:
    "bg-transparent hover:bg-surface-hover active:bg-subtle text-secondary hover:text-white focus-visible:ring-2 focus-visible:ring-orange-500/30",
  danger:
    "bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white border border-transparent shadow-sm shadow-rose-500/20 focus-visible:ring-2 focus-visible:ring-rose-500/50",
  "subtle-danger":
    "bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20 focus-visible:ring-2 focus-visible:ring-rose-500/30",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "text-xs px-2.5 py-1.5 rounded-lg gap-1.5",
  md: "text-sm px-3.5 py-2 rounded-lg gap-2",
  lg: "text-base px-4 py-2.5 rounded-xl gap-2.5",
  icon: "p-2 rounded-lg justify-center",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      isLoading = false,
      disabled,
      className = "",
      children,
      ...props
    },
    ref
  ) => {
    const base =
      "inline-flex items-center justify-center font-medium transition-all duration-150 select-none outline-none disabled:opacity-50 disabled:pointer-events-none cursor-pointer";
    const variantClass = variantStyles[variant] || variantStyles.primary;
    const sizeClass = sizeStyles[size] || sizeStyles.md;

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={`${base} ${variantClass} ${sizeClass} ${className}`.trim()}
        {...props}
      >
        {isLoading && (
          <svg
            className="animate-spin -ml-0.5 mr-1.5 h-3.5 w-3.5 text-current"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8v8H4z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
