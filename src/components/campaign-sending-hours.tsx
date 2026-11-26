"use client";

import { useState } from "react";
import { updateCampaign } from "@/lib/api/campaigns";
import { ApiClientError } from "@/lib/api/client";

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const COMMON_TIMEZONES = [
  "Asia/Karachi",
  "UTC",
  "America/Toronto",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Dubai",
  "Australia/Sydney",
];

export type SendingHoursValue = {
  enabled: boolean;
  start: string | null;
  end: string | null;
  days: number[] | null;
  timezone: string | null;
};

type Draft = {
  enabled: boolean;
  start: string;
  end: string;
  days: number[];
  timezone: string;
};

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * Campaign sending hours: the daily window (in a chosen timezone) when this
 * campaign's DMs may go out. Separate from each account's timer, which is
 * the gap between two messages from the same account.
 */
export function CampaignSendingHours({
  campaignId,
  value,
  onSaved,
}: {
  campaignId: string;
  value: SendingHoursValue | undefined;
  onSaved: () => void;
}) {
  // Unsaved edits live in `draft`; otherwise the server value is shown.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const current: Draft = draft ?? {
    enabled: value?.enabled ?? false,
    start: value?.start || "10:00",
    end: value?.end || "16:00",
    days: value?.days && value.days.length > 0 ? value.days : [0, 1, 2, 3, 4, 5, 6],
    timezone: value?.timezone || browserTimezone(),
  };
  const { enabled, start, end, days, timezone } = current;
  const dirty = draft !== null;

  const update = (patch: Partial<Draft>) => {
    setDraft({ ...current, ...patch });
    setMessage(null);
  };

  const save = async (nextEnabled = enabled) => {
    if (nextEnabled && start === end) {
      setMessage({ ok: false, text: "Start and end time must be different." });
      return;
    }
    if (nextEnabled && days.length === 0) {
      setMessage({ ok: false, text: "Pick at least one day." });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await updateCampaign(campaignId, {
        sendWindowEnabled: nextEnabled,
        sendWindowStart: start,
        sendWindowEnd: end,
        sendWindowDays: days,
        sendWindowTimezone: timezone,
      });
      setDraft(null);
      setMessage({
        ok: true,
        text: nextEnabled
          ? `Saved. Messages send ${start}–${end} (${timezone}).`
          : "Saved. Custom sending hours are off; default hours apply.",
      });
      onSaved();
    } catch (err) {
      setMessage({
        ok: false,
        text: err instanceof ApiClientError ? err.message : "Could not save sending hours.",
      });
    } finally {
      setSaving(false);
    }
  };

  const tzOptions = COMMON_TIMEZONES.includes(timezone)
    ? COMMON_TIMEZONES
    : [timezone, ...COMMON_TIMEZONES];

  return (
    <div className="mt-3 border-t border-indigo-500/20 pt-3 space-y-2.5" data-testid="campaign-sending-hours">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-semibold text-zinc-200">Sending hours</span>
          <span className="ml-2 text-[11px] text-zinc-500">
            When this campaign may send. Each account&apos;s timer (gap between its messages) is set in sender settings.
          </span>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => {
              const next = e.target.checked;
              update({ enabled: next });
              // Turning it off takes effect immediately.
              if (!next) void save(false);
            }}
            className="h-3.5 w-3.5 accent-orange-500"
          />
          Use custom hours
        </label>
      </div>

      {enabled && (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="sending-hours-start" className="block text-[10px] font-semibold uppercase text-zinc-400">
              From
            </label>
            <input
              id="sending-hours-start"
              type="time"
              value={start}
              disabled={saving}
              onChange={(e) => update({ start: e.target.value })}
              className="mt-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-orange-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="sending-hours-end" className="block text-[10px] font-semibold uppercase text-zinc-400">
              To
            </label>
            <input
              id="sending-hours-end"
              type="time"
              value={end}
              disabled={saving}
              onChange={(e) => update({ end: e.target.value })}
              className="mt-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-orange-500 focus:outline-none"
            />
          </div>
          <div>
            <label htmlFor="sending-hours-tz" className="block text-[10px] font-semibold uppercase text-zinc-400">
              Timezone
            </label>
            <select
              id="sending-hours-tz"
              value={timezone}
              disabled={saving}
              onChange={(e) => update({ timezone: e.target.value })}
              className="mt-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-orange-500 focus:outline-none"
            >
              {tzOptions.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>
          <div>
            <span className="block text-[10px] font-semibold uppercase text-zinc-400">Days</span>
            <div className="mt-1 flex gap-1">
              {DAY_LABELS.map((label, day) => {
                const active = days.includes(day);
                return (
                  <button
                    key={label}
                    type="button"
                    disabled={saving}
                    onClick={() =>
                      update({
                        days: active ? days.filter((d) => d !== day) : [...days, day].sort((a, b) => a - b),
                      })
                    }
                    className={`rounded-md border px-1.5 py-1 text-[10px] font-semibold transition ${
                      active
                        ? "border-orange-500/50 bg-orange-500/20 text-orange-200"
                        : "border-zinc-700 bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            disabled={saving || !dirty}
            onClick={() => void save(true)}
            className="rounded-lg border border-orange-500/50 bg-orange-500/15 px-3 py-1.5 text-xs font-semibold text-orange-200 transition hover:bg-orange-500/25 disabled:opacity-40"
          >
            {saving ? "Saving..." : "Save hours"}
          </button>
        </div>
      )}

      {message && (
        <div className={`text-[11px] ${message.ok ? "text-emerald-400" : "text-rose-400"}`}>{message.text}</div>
      )}
    </div>
  );
}
