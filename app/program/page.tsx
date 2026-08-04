import type { Metadata } from "next";
import ManyVueApp from "../CrowdCutApp";

export const metadata: Metadata = {
  title: "Program View",
  description: "Direct the ManyVue live multi-angle concert film.",
};

export default function ProgramPage() {
  return <ManyVueApp />;
}
