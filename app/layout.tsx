import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "crowdcut-live.ild.chatgpt.site";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const description = "The crowd is the camera. Join a live multi-angle concert film and take home your moment.";

  return {
    metadataBase: new URL(origin),
    title: {
      default: "CrowdCut Live",
      template: "%s · CrowdCut Live",
    },
    description,
    openGraph: {
      type: "website",
      url: origin,
      title: "CrowdCut Live — The Crowd Is the Camera",
      description,
      images: [{ url: `${origin}/og.png`, width: 1536, height: 1024, alt: "CrowdCut Live crowd-built concert camera" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "CrowdCut Live — The Crowd Is the Camera",
      description,
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${geist.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}
