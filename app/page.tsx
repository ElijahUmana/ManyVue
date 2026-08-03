import type { Metadata } from "next";
import CrowdCutApp from "./CrowdCutApp";
import HostLanding from "./HostLanding";

export const metadata: Metadata = {
  title: "CrowdCut Live",
  description: "Record your angle. See it go live. Take home the crowd.",
};

type HomeProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const view = Array.isArray(params.view) ? params.view[0] : params.view;

  // Camera QR links and the explicit Program View link must remain direct.
  // Only the clean public host URL receives the cinematic entrance.
  if (view === "camera" || view === "program") return <CrowdCutApp />;

  return <HostLanding />;
}
