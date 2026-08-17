import type { Metadata } from "next";
import ManyVueApp from "../ManyVueApp";

export const metadata: Metadata = {
  title: "Camera",
  description: "Allow Camera once and become a live ManyVue angle immediately.",
};

export default function CameraPage() {
  return <ManyVueApp />;
}
