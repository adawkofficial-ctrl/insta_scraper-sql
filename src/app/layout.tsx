import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en" className="dark">
      <body className="bg-zinc-950 text-zinc-100 antialiased selection:bg-rose-500 selection:text-white">
        {children}
      </body>
    </html>
  );
}
