import { getAccessCodeFromUrl } from "@/types";
import HostScreen from "@/components/HostScreen";
import GuestScreen from "@/components/GuestScreen";

export default function App() {
  const accessCode = getAccessCodeFromUrl();

  if (accessCode) {
    return <GuestScreen accessCode={accessCode} />;
  }

  return <HostScreen />;
}
