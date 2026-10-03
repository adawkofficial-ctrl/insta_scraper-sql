"use client";

import { useState } from "react";

type LeadAvatarProps = {
  profilePicUrlHD?: string | null;
  profilePicUrl?: string | null;
  profilePictureUrl?: string | null;
  username: string;
  size?: "sm" | "md" | "lg";
  className?: string;
};

export function LeadAvatar({
  profilePicUrlHD,
  profilePicUrl,
  profilePictureUrl,
  username,
  size = "md",
  className = "",
}: LeadAvatarProps) {
  const [hasError, setHasError] = useState(false);

  // Fallback hierarchy: profilePicUrlHD -> profilePicUrl -> profilePictureUrl -> placeholder
  const imageUrl = profilePicUrlHD || profilePicUrl || profilePictureUrl;

  const sizeClasses = {
    sm: "h-7 w-7 text-[10px]",
    md: "h-9 w-9 text-xs",
    lg: "h-16 w-16 text-lg",
  }[size];

  const initials = (username || "??").slice(0, 2).toUpperCase();

  if (!imageUrl || hasError) {
    return (
      <div
        className={`flex ${sizeClasses} items-center justify-center rounded-full bg-gradient-to-tr from-zinc-800 to-zinc-700 font-bold text-zinc-300 border border-zinc-700 shrink-0 select-none ${className}`}
        title={`@${username}`}
      >
        {initials}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={imageUrl}
      alt={username}
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className={`${sizeClasses} rounded-full border border-zinc-700 object-cover shrink-0 ${className}`}
    />
  );
}
