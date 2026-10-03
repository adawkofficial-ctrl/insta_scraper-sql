"use client";

import { Navbar } from "@/components/navbar";
import { InstagramSenderSettings } from "@/components/instagram-sender-settings";
import { CompanyProfileSettings } from "@/components/company-profile-settings";
import { DoNotContactSettings } from "@/components/do-not-contact-settings";
import { NotificationSettingsPanel } from "@/components/notifications-settings-panel";

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <Navbar />
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6 lg:px-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Manage integrations, sender accounts, notifications, and outreach suppression policies.
          </p>
        </div>
        <NotificationSettingsPanel />
        <CompanyProfileSettings />
        <InstagramSenderSettings />
        <DoNotContactSettings />
      </main>
    </div>
  );
}
