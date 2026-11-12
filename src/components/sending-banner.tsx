"use client";

import { useEffect, useState } from "react";

export function useSendingStatus(): { sendingEnabled: boolean; loading: boolean } {
  const [sendingEnabled, setSendingEnabled] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    fetch("/api/health/ready")
      .then((res) => res.json())
      .then((data) => {
        if (!mounted) return;
        const status = data?.checks?.outbound_sending;
        if (status === "disabled") {
          setSendingEnabled(false);
        } else if (status === "enabled") {
          setSendingEnabled(true);
        }
        setLoading(false);
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return { sendingEnabled, loading };
}

export function SendingBanner() {
  const [sendingDisabled, setSendingDisabled] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    fetch("/api/health/ready")
      .then((res) => res.json())
      .then((data) => {
        if (!mounted) return;
        const status = data?.checks?.outbound_sending;
        if (status === "disabled") {
          setSendingDisabled(true);
        } else if (status === "enabled") {
          setSendingDisabled(false);
        }
      })
      .catch(() => {
        // Fallback: don't show banner if probe fails
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (!sendingDisabled) {
    return null;
  }

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 flex items-center justify-center gap-2 border-b border-amber-500/30 bg-amber-500/15 px-4 py-2 text-center text-xs sm:text-sm font-medium text-amber-900 dark:text-amber-200 backdrop-blur-md shadow-sm"
    >
      <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
      <span>
        <strong>Sending is OFF - discovery only</strong> (OUTBOUND_SENDING_ENABLED=false)
      </span>
    </div>
  );
}
