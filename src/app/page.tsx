import { redirect } from "next/navigation";

// My team is the first tab, so the root goes there.
export default function Home() {
  redirect("/my-team");
}
