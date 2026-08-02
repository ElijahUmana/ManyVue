import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "CrowdCut Live",
    template: "%s · CrowdCut Live",
  },
  description:
    "The crowd is the camera. Join a live multi-angle concert film and take home your moment.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geist.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
