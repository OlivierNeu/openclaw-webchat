import "./chat/convexChat.css";
import { ConvexChatApp } from "./chat/ConvexChatApp";
import { DialogsProvider } from "@/components/ConfirmDialog";

// Root app = the Convex + assistant-ui webchat, gated by Convex Auth
// (Authenticated/Unauthenticated boundary lives inside ConvexChatApp).
// main.tsx wraps this in <ConvexAuthProvider>. DialogsProvider supplies the
// app-wide confirm/prompt modals (replacing native window.confirm/prompt).
function App() {
  return (
    <DialogsProvider>
      <ConvexChatApp />
    </DialogsProvider>
  );
}

export default App;
