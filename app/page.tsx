import type { Metadata } from "next";
import CrowdCutApp from "./CrowdCutApp";

export const metadata: Metadata = {
  title: "CrowdCut Live",
  description: "Record your angle. See it go live. Take home the crowd.",
};

export default function Home() {
  return <CrowdCutApp />;
}
