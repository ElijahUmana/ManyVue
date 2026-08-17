import type { Metadata } from "next";
import { redirect } from "next/navigation";
import HostLanding from "./HostLanding";

export const metadata: Metadata = {
  title: "ManyVue Live",
  description: "Record your angle. See it go live. Take home the crowd.",
};

type HomeProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function Home({ searchParams }: HomeProps) {
  const params = await searchParams;
  const view = Array.isArray(params.view) ? params.view[0] : params.view;

  // Preserve old QR and bookmark URLs while keeping the cinematic landing
  // route free of the production camera bundle.
  if (view === "camera") {
    const session = Array.isArray(params.session) ? params.session[0] : params.session;
    redirect(session ? `/camera?session=${encodeURIComponent(session)}` : "/camera");
  }
  if (view === "program") redirect("/program");

  return <HostLanding />;
}
