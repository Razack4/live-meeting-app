import { getRoomIdFromUrl } from "@/types";
import HostScreen from "@/components/HostScreen";
import GuestScreen from "@/components/GuestScreen";

export default function App() {
  const roomId = getRoomIdFromUrl();

  if (roomId) {
    return <GuestScreen roomId={roomId} />;
  }

  return <HostScreen />;
}
