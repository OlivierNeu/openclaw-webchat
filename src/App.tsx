import "./chat/convexChat.css";
import { ConvexChatApp } from "./chat/ConvexChatApp";

// Root app = the Convex + assistant-ui webchat, gated by Convex Auth
// (Authenticated/Unauthenticated boundary lives inside ConvexChatApp).
// main.tsx wraps this in <ConvexAuthProvider>.
function App() {
  return <ConvexChatApp />;
}

export default App;
