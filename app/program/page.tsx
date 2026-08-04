import type { Metadata } from "next";
import CrowdCutApp from "../CrowdCutApp";

export const metadata: Metadata = {
  title: "Program View",
  description: "Direct the CrowdCut live multi-angle concert film.",
};

export default function ProgramPage() {
  return <CrowdCutApp />;
}
