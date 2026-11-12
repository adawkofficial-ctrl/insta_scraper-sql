"use client";

import { Navbar } from "@/components/navbar";
import { InstagramSenderSettings } from "@/components/instagram-sender-settings";
import { CompanyProfileSettings } from "@/components/company-profile-settings";
import { NotificationSettingsPanel } from "@/components/notifications-settings-panel";
import { DryRunCleanupPanel } from "@/components/dry-run-cleanup-panel";

export default function SettingsPage() {
  return (
    <div className="min-h-screen bg-app text-primary flex flex-col transition-colors duration-150">
      <Navbar />
      <main className="flex-1 mx-auto w-full max-w-5xl space-y-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="border-b border-subtle pb-6">
          <h1 className="text-2xl font-bold tracking-tight text-primary sm:text-3xl">Settings</h1>
          <p className="mt-1 text-sm text-muted">
            Manage integrations, sender accounts, notifications, and test data cleanup.
          </p>
        </div>
        <NotificationSettingsPanel />
        <CompanyProfileSettings />
        <InstagramSenderSettings />
        <DryRunCleanupPanel />
      </main>
    </div>
  );
}
