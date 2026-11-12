import type { Metadata } from "next";
import "./globals.css";
import { SendingBanner } from "@/components/sending-banner";

export const metadata: Metadata = {
  title: "InstaScraper | Instagram Lead & Campaign Engine",
  description: "Campaign and lead management SaaS for Instagram outreach.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              try {
                const storedTheme = localStorage.getItem("theme");
                if (storedTheme === "light") {
                  document.documentElement.classList.remove("dark");
                } else {
                  document.documentElement.classList.add("dark");
                }
              } catch (_) {
                document.documentElement.classList.add("dark");
              }
            `,
          }}
        />
      </head>
      <body className="bg-app text-primary antialiased selection:bg-indigo-500 selection:text-white min-h-screen transition-colors duration-150">
        <SendingBanner />
        {children}
      </body>
    </html>
  );
}
