import { redirect } from "next/navigation";

// League is the first tab, so the root goes there.
export default function Home() {
  redirect("/league");
}
