import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SendingBanner } from "@/components/sending-banner";

export const metadata: Metadata = {
  title: "InstaScraper | Instagram Lead & Campaign Engine",
  description: "Campaign and lead management SaaS for Instagram outreach.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The UI is black-first (black / orange / white). The `dark` class is fixed
  // so every `dark:` variant in the components applies consistently.
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="bg-app text-primary antialiased min-h-screen">
        <SendingBanner />
        {children}
      </body>
    </html>
  );
}
