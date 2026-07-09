import { withAuth } from "next-auth/middleware";

// The middleware must be told about the custom sign-in page explicitly —
// it cannot read authOptions.pages, and without this unauthenticated users
// land on NextAuth's unstyled default page instead of /login.
export default withAuth({ pages: { signIn: "/login" } });

// Everything requires a session except auth pages, NextAuth's own routes,
// and the unauthenticated liveness probe used by platform health checks.
export const config = {
  matcher: [
    "/((?!login|register|api/auth|api/healthz|_next/static|_next/image|favicon.ico|icon.svg).*)",
  ],
};
