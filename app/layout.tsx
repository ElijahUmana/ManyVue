import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geist = Geist({ variable: "--font-geist", subsets: ["latin"] });
const mono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") || requestHeaders.get("host") || "manyvue-live.ild.chatgpt.site";
  const protocol = requestHeaders.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const description = "The crowd is the camera. Join a live multi-angle concert film and take home your moment.";

  return {
    metadataBase: new URL(origin),
    title: {
      default: "ManyVue Live",
      template: "%s · ManyVue Live",
    },
    description,
    icons: {
      icon: [{ url: "/manyvue-icon.png", type: "image/png", sizes: "1024x1024" }],
      apple: [{ url: "/manyvue-icon.png", type: "image/png", sizes: "1024x1024" }],
    },
    openGraph: {
      type: "website",
      url: origin,
      title: "ManyVue Live — The Crowd Is the Camera",
      description,
      images: [{ url: `${origin}/og.png`, width: 1536, height: 1024, alt: "ManyVue Live turns a crowd of phones into one concert camera crew" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "ManyVue Live — The Crowd Is the Camera",
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
